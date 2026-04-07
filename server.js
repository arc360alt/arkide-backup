const express = require('express');
const path = require('path');
const fs = require('fs');
const { BSON } = require('bson');
const pmp_protobuf = require('pmp-protobuf');

const app = express();
const PORT = process.env.PORT || 3040;

// Path to your backup folders
const MONGO_BACKUP  = process.env.MONGO_BACKUP  || path.join(__dirname, 'backup/mongo/pm_apidata');
const MINIO_BACKUP  = process.env.MINIO_BACKUP  || path.join(__dirname, 'backup/minio');

// ---------------------------------------------------------------------------
// Load all BSON collections into memory at startup (they're read-only anyway)
// ---------------------------------------------------------------------------
function loadCollection(name) {
    const file = path.join(MONGO_BACKUP, `${name}.bson`);
    if (!fs.existsSync(file)) {
        console.warn(`Warning: ${file} not found, ${name} will be empty.`);
        return [];
    }
    const buf = fs.readFileSync(file);
    const docs = [];
    let offset = 0;
    while (offset < buf.length) {
        const size = buf.readInt32LE(offset);
        const docBuf = buf.slice(offset, offset + size);
        docs.push(BSON.deserialize(docBuf));
        offset += size;
    }
    console.log(`Loaded ${docs.length} documents from ${name}.bson`);
    return docs;
}

let projects = [];
let users    = [];

function initCollections() {
    projects = loadCollection('projects');
    users    = loadCollection('users');
    console.log('All collections loaded.');
}

// ---------------------------------------------------------------------------
// In-memory query helpers (mirrors the MongoDB queries used before)
// ---------------------------------------------------------------------------
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getUser(authorId) {
    return users.find(u => u.id === authorId);
}

// ---------------------------------------------------------------------------
// MinIO file helpers
// ---------------------------------------------------------------------------
function minioPath(bucket, objectName) {
    return path.join(MINIO_BACKUP, bucket, objectName);
}

function readMinioObject(bucket, objectName) {
    const filePath = minioPath(bucket, objectName);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
}

function listMinioObjects(bucket, prefix) {
    const dir = path.join(MINIO_BACKUP, bucket);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/projects — paginated, searchable
app.get('/api/projects', (req, res) => {
    try {
        const page     = parseInt(req.query.page)     || 0;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const search   = req.query.search || '';

        let filtered = projects.filter(p => p.hardReject !== true);

        if (search) {
            const rx = new RegExp(escapeRegex(search), 'i');
            filtered = filtered.filter(p =>
                rx.test(p.title || '') || rx.test(p.instructions || '')
            );
        }

        // Sort by lastUpdate descending
        filtered.sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));

        const total  = filtered.length;
        const paged  = filtered.slice(page * pageSize, page * pageSize + pageSize);

        const result = paged.map(p => {
            const author = getUser(p.author);
            return {
                id:             p.id,
                title:          p.title,
                date:           p.date,
                lastUpdate:     p.lastUpdate,
                views:          p.views,
                public:         p.public,
                rating:         p.rating,
                authorUsername: author ? author.username : null
            };
        });

        res.json({ projects: result, total, page, pageSize });
    } catch (err) {
        console.error('Error fetching projects:', err);
        res.status(500).json({ error: 'Internal error', details: err.message });
    }
});

// GET /api/projects/:id/download — decode protobuf + bundle assets into .arkide
app.get('/api/projects/:id/download', async (req, res) => {
    const id = req.params.id;

    try {
        // 1. Read the raw protobuf from the projects bucket backup
        const protobufBuffer = readMinioObject('projects', id);
        if (!protobufBuffer) {
            return res.status(404).send('Project file not found in backup.');
        }

        // 2. Find all assets for this project
        const assetNames = listMinioObjects('project-assets', `${id}_`);
        const assets = assetNames.map(assetName => {
            const assetBuffer = readMinioObject('project-assets', assetName);
            // Asset names are stored as "projectId_assetId"
            const assetId = assetName.split('_').slice(1).join('_');
            return { id: assetId, buffer: assetBuffer };
        }).filter(a => a.buffer !== null);

        // 3. Convert protobuf + assets → proper .arkide zip
        const pmpArrayBuffer = await pmp_protobuf.protobufToPMP(protobufBuffer, assets);
        const pmpBuffer = Buffer.from(pmpArrayBuffer);

        // 4. Use a clean filename
        const project = projects.find(p => p.id === id);
        let title = id;
        if (project?.title) {
            title = project.title.replace(/[^a-z0-9 _-]/gi, '').trim() || id;
        }

        res.setHeader('Content-Disposition', `attachment; filename="${title}.arkide"`);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', pmpBuffer.length);
        res.send(pmpBuffer);

    } catch (err) {
        console.error('Download error:', err);
        res.status(500).send('Failed to build project file: ' + err.message);
    }
});

// GET /api/projects/:id/info
app.get('/api/projects/:id/info', (req, res) => {
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    // Strip internal MongoDB _id before sending
    const { _id, ...safe } = project;
    res.json(safe);
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
    const projectCount = projects.filter(p => p.hardReject !== true).length;
    const userCount    = users.filter(u => u.permBanned === false).length;
    const totalViews   = projects
        .filter(p => typeof p.views === 'number' && p.views >= 0)
        .reduce((sum, p) => sum + p.views, 0);

    res.json({ projectCount, userCount, totalViews });
});

// Fallback → SPA
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initCollections();
app.listen(PORT, '0.0.0.0', () => {
    console.log(`ArkIDE Goodbye server running on http://localhost:${PORT}`);
});
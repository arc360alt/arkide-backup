const fs = require('fs');
const BSON = require('bson');

const inputPath = 'backup/mongo/pm_apidata/users.bson';
const outputPath = 'backup/mongo/pm_apidata/users_sanitized.bson';

const buffer = fs.readFileSync(inputPath);
const documents = [];
let offset = 0;


while (offset < buffer.length) {
    const docSize = buffer.readInt32LE(offset);
    const docBuffer = buffer.slice(offset, offset + docSize);
    const doc = BSON.deserialize(docBuffer);
    delete doc.password;
    delete doc.tokens;
    delete doc.token;
    delete doc.email;
    delete doc.birthdayEntered;
    delete doc.birthday;
    documents.push(BSON.serialize(doc));
    offset += docSize;
}

const sanitizedBuffer = Buffer.concat(documents);
fs.writeFileSync(outputPath, sanitizedBuffer);

console.log(outputPath);
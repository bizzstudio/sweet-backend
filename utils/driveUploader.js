const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// הטמעת Google Auth עם חשבון השירות - נטען ממשתנה הסביבה, עם נפילה לקובץ מקומי בפיתוח
const serviceAccountPath = path.join(__dirname, 'upload-images-435010-b13a3e3ba095.json');
const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : (fs.existsSync(serviceAccountPath) ? require(serviceAccountPath) : null);

const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

// הגדרה של multer לקליטת קבצים
const upload = multer({ dest: 'uploads/' });

// פונקציה שמחפשת תיקייה לפי שם
const findOrCreateFolder = async (folderName) => {
    try {
        // חיפוש תיקייה עם שם נתון
        const response = await drive.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
        });

        const folders = response.data.files;

        if (folders.length > 0) {
            // אם התיקייה קיימת, החזר את ה-id שלה
            return folders[0].id;
        } else {
            // אם התיקייה לא קיימת, צור אותה
            const folderMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            };

            const createResponse = await drive.files.create({
                resource: folderMetadata,
                fields: 'id',
            });

            return createResponse.data.id;
        }
    } catch (error) {
        console.error('Error finding or creating folder:', error);
        throw new Error('Error creating or finding folder');
    }
};

const uploadFileToDrive = async (file, folderName = 'Uploads') => {
    try {
        const filePath = file.path;

        // חפש או צור את התיקייה
        const folderId = await findOrCreateFolder(folderName);

        // העלאה ל-Google Drive
        const response = await drive.files.create({
            requestBody: {
                name: file.originalname,
                mimeType: file.mimetype,
                parents: [folderId], // שימוש במזהה התיקייה שנמצא או נוצר
            },
            media: {
                mimeType: file.mimetype,
                body: fs.createReadStream(filePath),
            },
        });

        const fileId = response.data.id;

        // הפיכת הקובץ לציבורי (אופציונלי)
        await drive.permissions.create({
            fileId: fileId,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });

        // מחזיר את הלינק לצפייה בקובץ
        const link = `https://drive.google.com/uc?export=view&id=${fileId}`;

        // מחיקת הקובץ המקומי לאחר ההעלאה
        fs.unlinkSync(filePath);

        return link;
    } catch (error) {
        console.error('Error uploading file:', error);
        throw new Error('Error uploading file to Google Drive');
    }
};

module.exports = { upload, uploadFileToDrive };

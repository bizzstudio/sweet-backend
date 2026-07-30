// awsUploader.js
require('dotenv').config();
const multer = require('multer');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { v4: uuidv4 } = require('uuid');

// הגדרת multer לשמירה בזיכרון (Memory Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// הגדרת AWS עם פרטי הסביבה
const s3 = new S3Client({
    region: process.env.AMAZON_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// פונקציה להעלאת קובץ ל-S3 ולחיפוש תיקייה
const uploadFileToS3 = async (file, folderName = 'Uploads', email) => {
    try {
        // בדיקת גודל הקובץ - לא יותר מ-10MB
        const maxFileSize = 10 * 1024 * 1024; // 10MB בבתים
        if (file.size > maxFileSize) {
            throw new Error('File size exceeds 10MB limit');
        }

        // המרת שם הקובץ ל-UTF-8 תקין והחלפתו
        const originalnameUtf8 = Buffer.from(file.originalname, 'latin1').toString('utf8');

        // יצירת שם ייחודי עם UUID
        const uniqueFileName = `${uuidv4()}_${originalnameUtf8}`;
        const filePath = `${folderName}/${uniqueFileName}`;

        const upload = new Upload({
            client: s3,
            params: {
                Bucket: process.env.BUCKET,
                Key: filePath,
                Body: file.buffer,
                ContentType: file.mimetype,
                // שם הקובץ ייחודי (UUID) ולכן התוכן לעולם לא משתנה תחת אותו URL —
                // cache ארוך + immutable חוסך הורדות חוזרות (פותר "efficient cache lifetimes").
                CacheControl: 'public, max-age=31536000, immutable',
            }
        });

        await upload.done();

        return `https://${process.env.BUCKET}.s3.${process.env.AMAZON_REGION}.amazonaws.com/${filePath}`;
    } catch (error) {
        console.error('Error uploading file to AWS S3:', error);
        throw new Error('Error uploading file to AWS S3');
    }
};

// פונקציה למחיקת קובץ מ-S3
const deleteFileFromS3 = async (fileUrl) => {
    try {
        console.log('fileUrl :>> ', fileUrl);
        const bucketName = process.env.BUCKET;

        // חילוץ ה-Key מתוך ה-URL בצורה נכונה
        const urlPrefix = `https://${bucketName}.s3.${process.env.AMAZON_REGION}.amazonaws.com/`;
        const fileKey = fileUrl.replace(urlPrefix, '');

        const params = {
            Bucket: bucketName,
            Key: fileKey,
        };

        const command = new DeleteObjectCommand(params);
        await s3.send(command);
        console.log(`File deleted from S3: ${fileKey}`);
    } catch (error) {
        console.error("Error deleting file from S3:", error);
        // throw new Error('Error deleting file from S3');
    }
};

module.exports = { upload, uploadFileToS3, deleteFileFromS3 };
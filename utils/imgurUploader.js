const axios = require('axios');
const FormData = require('form-data'); // ודא שאתה מייבא את המודול הנכון
const multer = require('multer');

// הגדרת multer לשמירה בזיכרון (Memory Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const uploadFileToImgur = async (file) => {
    try {
        const formData = new FormData();
        formData.append('image', file.buffer); // משתמשים ב-buffer במקום ב-readStream

        const response = await axios.post('https://api.imgur.com/3/image', formData, {
            headers: {
                Authorization: `Client-ID ${process.env.KIRSHNER_IMGUR_CLIENT_ID}`, // שימוש ב-Client ID
                ...formData.getHeaders(), // ניהול נכון של כותרות המולטיפרט
            },
        });

        return response.data.data; // החזרת נתוני התמונה מה-API
    } catch (error) {
        console.error('Error uploading to Imgur:', error.response ? error.response.data : error.message);
        throw new Error('Error uploading file to Imgur');
    }
};

module.exports = { upload, uploadFileToImgur };

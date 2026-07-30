// models/Blog.js
const mongoose = require('mongoose');

const blogSchema = new mongoose.Schema(
    {
        title: {
            type: Object, // כדי לתמוך בריבוי שפות כמו במודלים האחרים
            required: true,
        },
        preview: {
            type: Object, // טקסט תצוגה מקדימה - תמיכה בריבוי שפות
        },
        publishDate: {
            type: Date,
            default: Date.now,
            required: true,
        },
        author: {
            type: String,
        },
        content: {
            type: Object, // תוכן המאמר - תמיכה בריבוי שפות
            required: true,
        },
        mainImage: {
            type: String, // URL של התמונה הראשית
            required: false,
        },
        authorImage: {
            type: String, // URL של תמונת המפרסם
            required: false,
        },
        category: {
            type: String, // קטגוריית מאמר - טקסט חופשי
        },
        slug: {
            type: String,
            required: true,
            unique: true,
        },
        status: {
            type: String,
            lowercase: true,
            enum: ['published', 'draft', 'hidden'],
            default: 'draft',
        },
        views: {
            type: Number,
            default: 0,
        },
        tags: [String], // תגיות למאמר
    },
    {
        timestamps: true,
    }
);

const Blog = mongoose.model('Blog', blogSchema);
module.exports = Blog; 
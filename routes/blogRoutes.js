// routes/blogRoutes.js
const express = require('express');
const router = express.Router();
const {
    // Admin functions
    addBlog,
    getAllBlogs,
    getBlogById,
    getBlogBySlug,
    updateBlog,
    deleteBlog,
    deleteManyBlogs,

    // Store functions
    getPublishedBlogs,
    getPublishedBlogBySlug,
    getBlogCategories,
    getBlogTags,
} = require('../controller/blogController');
const { isAdmin } = require('../config/auth');

// Admin routes - CRUD מלא
// הוספת מאמר חדש
router.post('/add', isAdmin, addBlog);

// קבלת כל המאמרים (כולל טיוטות)
router.get('/admin/all', isAdmin, getAllBlogs);

// קבלת מאמר לפי ID (לאדמין)
router.get('/admin/:id', isAdmin, getBlogById);

// קבלת מאמר לפי slug (לאדמין)
router.get('/admin/slug/:slug', isAdmin, getBlogBySlug);

// עדכון מאמר
router.put('/:id', isAdmin, updateBlog);

// מחיקת מאמר
router.delete('/:id', isAdmin, deleteBlog);

// מחיקת מספר מאמרים
router.patch('/delete/many', isAdmin, deleteManyBlogs);

// Store routes - קריאה בלבד של מאמרים פורסמים
// קבלת מאמרים פורסמים עם פג'ינציה וסינון
router.get('/published', getPublishedBlogs);

// קבלת מאמר מפורסם לפי slug
router.get('/published/:slug', getPublishedBlogBySlug);

// קבלת קטגוריות מאמרים מפורסמים
router.get('/categories', getBlogCategories);

// קבלת תגיות מאמרים מפורסמים
router.get('/tags', getBlogTags);

module.exports = router; 
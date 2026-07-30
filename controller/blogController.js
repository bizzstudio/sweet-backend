// controller/blogController.js
const Blog = require("../models/Blog");
const mongoose = require("mongoose");

// Admin functions - CRUD מלא
const addBlog = async (req, res) => {
    try {
        const newBlog = new Blog({
            ...req.body,
        });

        await newBlog.save();
        res.status(201).send({
            message: "המאמר נוסף בהצלחה",
            blog: newBlog,
        });
    } catch (err) {
        console.log('addBlog error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const getAllBlogs = async (req, res) => {
    try {
        const blogs = await Blog.find({}).sort({ publishDate: -1 });
        res.send(blogs);
    } catch (err) {
        console.log('getAllBlogs error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const getBlogById = async (req, res) => {
    try {
        const blog = await Blog.findById(req.params.id);
        if (!blog) {
            return res.status(404).send({ message: "המאמר לא נמצא" });
        }
        res.send(blog);
    } catch (err) {
        console.log('getBlogById error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const getBlogBySlug = async (req, res) => {
    try {
        const blog = await Blog.findOne({ slug: req.params.slug });
        if (!blog) {
            return res.status(404).send({ message: "המאמר לא נמצא" });
        }

        // עדכון מספר הצפיות
        blog.views += 1;
        await blog.save();

        res.send(blog);
    } catch (err) {
        console.log('getBlogBySlug error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const updateBlog = async (req, res) => {
    try {
        const updatedBlog = await Blog.findByIdAndUpdate(
            req.params.id,
            { ...req.body },
            { new: true }
        );

        if (!updatedBlog) {
            return res.status(404).send({ message: "המאמר לא נמצא" });
        }

        res.send({
            message: "המאמר עודכן בהצלחה",
            blog: updatedBlog,
        });
    } catch (err) {
        console.log('updateBlog error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const deleteBlog = async (req, res) => {
    try {
        const deletedBlog = await Blog.findByIdAndDelete(req.params.id);

        if (!deletedBlog) {
            return res.status(404).send({ message: "המאמר לא נמצא" });
        }

        res.send({
            message: "המאמר נמחק בהצלחה",
        });
    } catch (err) {
        console.log('deleteBlog error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

// Store functions - Read בלבד
const getPublishedBlogs = async (req, res) => {
    try {
        const { page = 1, limit = 10, category, tag } = req.query;
        const skip = (page - 1) * limit;

        let query = { status: 'published' };

        if (category) {
            query.category = category;
        }

        if (tag) {
            query.tags = { $in: [tag] };
        }

        const blogs = await Blog.find(query)
            .sort({ publishDate: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const totalBlogs = await Blog.countDocuments(query);

        res.send({
            blogs,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalBlogs / limit),
            totalBlogs,
        });
    } catch (err) {
        console.log('getPublishedBlogs error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const getPublishedBlogBySlug = async (req, res) => {
    try {
        const blog = await Blog.findOne({
            slug: req.params.slug,
            status: 'published'
        });

        if (!blog) {
            return res.status(404).send({ message: "המאמר לא נמצא או לא פורסם" });
        }

        // עדכון מספר הצפיות
        blog.views += 1;
        await blog.save();

        res.send(blog);
    } catch (err) {
        console.log('getPublishedBlogBySlug error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const getBlogCategories = async (req, res) => {
    try {
        // חיפוש קטגוריות מתוך מאמרים פורסמים
        const categories = await Blog.distinct('category', { status: 'published' });
        res.send(categories);
    } catch (err) {
        console.log('getBlogCategories error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const getBlogTags = async (req, res) => {
    try {
        // חיפוש תגיות מתוך מאמרים פורסמים
        const tags = await Blog.distinct('tags', { status: 'published' });
        res.send(tags);
    } catch (err) {
        console.log('getBlogTags error: ', err);
        res.status(500).send({
            message: err.message,
        });
    }
};

const deleteManyBlogs = async (req, res) => {
  try {
    // מחיקת מספר מאמרים לפי מערך של IDs
    await Blog.deleteMany({ _id: req.body.ids });

    res.send({
      message: `המאמרים נמחקו בהצלחה!`,
    });
  } catch (err) {
    console.log('deleteManyBlogs error: ', err);
    res.status(500).send({
      message: err.message,
    });
  }
};

module.exports = {
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
};
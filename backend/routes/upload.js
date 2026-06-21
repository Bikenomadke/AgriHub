import { Router } from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { extname } from "path";
import { authenticate } from "../middleware/auth.js";
import { supabaseAdmin } from "../utils/supabase-client.js";

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only JPG, PNG, and WebP are allowed."), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } 
});

const router = Router();

router.post("/ticket-image", authenticate, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Ensure Supabase is configured
    if (!supabaseAdmin) {
      return res.status(500).json({ error: "Cloud storage is not configured. Missing Supabase keys." });
    }

    const ext = extname(req.file.originalname).toLowerCase();
    const filename = `${uuid()}${ext}`;

    // Upload the file buffer directly to Supabase Storage (bucket named 'uploads')
    const { data, error } = await supabaseAdmin.storage
      .from('uploads')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (error) {
      console.error("Supabase storage error:", error);
      return res.status(500).json({ error: "Failed to save file to cloud storage" });
    }

    // Retrieve the public URL for the uploaded file
    const { data: publicUrlData } = supabaseAdmin.storage
      .from('uploads')
      .getPublicUrl(filename);

    res.json({ 
      url: publicUrlData.publicUrl, 
      filename: filename 
    });
  } catch (error) {
    console.error("Upload route error:", error);
    res.status(500).json({ error: "An unexpected error occurred during upload" });
  }
});

export default router;

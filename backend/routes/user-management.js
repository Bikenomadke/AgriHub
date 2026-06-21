import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { logAuditEvent } from "../utils/audit-logger.js";
import { supabaseAdmin } from "../utils/supabase-client.js";

const router = Router();

router.use(authenticate);

// ─── Create Field Officer Account ───────────────────────────────────────────────
router.post("/field-officers", authorize("Admin"), async (req, res) => {
  try {
    const { email, password, name, phone, location } = req.body;
    const adminId = req.user.id;

    if (!email || !password || !name) {
      return res.status(400).json({ error: "email, password, and name are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long" });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Check if user already exists in local database
    const existingUser = await queryOne(
      `SELECT id FROM agrihub.users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (existingUser) {
      return res.status(400).json({ error: "User with this email already exists" });
    }

    // Create user in Supabase
    const { data: supabaseUser, error: supabaseError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: 'Field Officer',
        name,
        phone,
        location
      }
    });

    if (supabaseError) {
      console.error("Supabase user creation error:", supabaseError);
      return res.status(400).json({ error: supabaseError.message });
    }

    // Create user record in local database
    const userId = uuid();
    await pool.query(
      `INSERT INTO agrihub.users (id, email, name, role, phone, location, created_by, created_at)
       VALUES ($1, $2, $3, 'Field Officer', $4, $5, $6, NOW())`,
      [userId, email, name, phone || null, location || null, adminId]
    );

    // Log audit event
    await logAuditEvent({
      userId: adminId,
      action: "field_officer_created",
      entityType: "user",
      entityId: userId,
      beforeState: null,
      afterState: { email, name, role: 'Field Officer' }
    });

    res.status(201).json({
      id: userId,
      email,
      name,
      role: 'Field Officer',
      phone,
      location,
      supabaseId: supabaseUser.user.id
    });
  } catch (error) {
    console.error("Error creating field officer:", error);
    res.status(500).json({ error: "Failed to create field officer" });
  }
});

// ─── Create Trader Account ───────────────────────────────────────────────────────
router.post("/traders", authorize("Admin"), async (req, res) => {
  try {
    const { email, password, name, phone, company_name, location } = req.body;
    const adminId = req.user.id;

    if (!email || !password || !name) {
      return res.status(400).json({ error: "email, password, and name are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long" });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Check if user already exists in local database
    const existingUser = await queryOne(
      `SELECT id FROM agrihub.users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (existingUser) {
      return res.status(400).json({ error: "User with this email already exists" });
    }

    // Create user in Supabase
    const { data: supabaseUser, error: supabaseError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        role: 'Trader',
        name,
        phone,
        company_name,
        location
      }
    });

    if (supabaseError) {
      console.error("Supabase user creation error:", supabaseError);
      return res.status(400).json({ error: supabaseError.message });
    }

    // Create user record in local database
    const userId = uuid();
    await pool.query(
      `INSERT INTO agrihub.users (id, email, name, role, phone, location, company_name, created_by, created_at)
       VALUES ($1, $2, $3, 'Trader', $4, $5, $6, $7, NOW())`,
      [userId, email, name, phone || null, location || null, company_name || null, adminId]
    );

    // Log audit event
    await logAuditEvent({
      userId: adminId,
      action: "trader_created",
      entityType: "user",
      entityId: userId,
      beforeState: null,
      afterState: { email, name, role: 'Trader', company_name }
    });

    res.status(201).json({
      id: userId,
      email,
      name,
      role: 'Trader',
      phone,
      location,
      company_name,
      supabaseId: supabaseUser.user.id
    });
  } catch (error) {
    console.error("Error creating trader:", error);
    res.status(500).json({ error: "Failed to create trader" });
  }
});

// ─── Get All Field Officers ───────────────────────────────────────────────────────
router.get("/field-officers", authorize("Admin"), async (req, res) => {
  try {
    const fieldOfficers = await queryMany(
      `SELECT id, email, name, phone, location, created_at, created_by, status
       FROM agrihub.users 
       WHERE role = 'Field Officer' AND deleted_at IS NULL
       ORDER BY created_at DESC`
    );

    res.json({ fieldOfficers });
  } catch (error) {
    console.error("Error fetching field officers:", error);
    res.status(500).json({ error: "Failed to fetch field officers" });
  }
});

// ─── Get All Traders ─────────────────────────────────────────────────────────────
router.get("/traders", authorize("Admin"), async (req, res) => {
  try {
    const traders = await queryMany(
      `SELECT id, email, name, phone, location, company_name, created_at, created_by, status
       FROM agrihub.users 
       WHERE role = 'Trader' AND deleted_at IS NULL
       ORDER BY created_at DESC`
    );

    res.json({ traders });
  } catch (error) {
    console.error("Error fetching traders:", error);
    res.status(500).json({ error: "Failed to fetch traders" });
  }
});

// ─── Update User Status (Active/Inactive) ─────────────────────────────────────────
router.patch("/users/:id/status", authorize("Admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const adminId = req.user.id;

    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
    }

    const user = await queryOne(
      `SELECT id, email, name, role, status FROM agrihub.users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.role === 'Admin') {
      return res.status(403).json({ error: "Cannot modify admin user status" });
    }

    await pool.query(
      `UPDATE agrihub.users SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id]
    );

    // Log audit event
    await logAuditEvent({
      userId: adminId,
      action: "user_status_updated",
      entityType: "user",
      entityId: id,
      beforeState: { status: user.status },
      afterState: { status }
    });

    res.json({ id, status });
  } catch (error) {
    console.error("Error updating user status:", error);
    res.status(500).json({ error: "Failed to update user status" });
  }
});

// ─── Delete User ────────────────────────────────────────────────────────────────
router.delete("/users/:id", authorize("Admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const user = await queryOne(
      `SELECT id, email, name, role FROM agrihub.users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.role === 'Admin') {
      return res.status(403).json({ error: "Cannot delete admin user" });
    }

    // Soft delete user
    await pool.query(
      `UPDATE agrihub.users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Log audit event
    await logAuditEvent({
      userId: adminId,
      action: "user_deleted",
      entityType: "user",
      entityId: id,
      beforeState: { email: user.email, name: user.name, role: user.role },
      afterState: null
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ─── Reset User Password ─────────────────────────────────────────────────────────
router.post("/users/:id/reset-password", authorize("Admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const adminId = req.user.id;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters long" });
    }

    const user = await queryOne(
      `SELECT id, email, name, role FROM agrihub.users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    // Update password in Supabase
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      user.supabase_id,
      { password: newPassword }
    );

    if (updateError) {
      console.error("Supabase password update error:", updateError);
      return res.status(400).json({ error: updateError.message });
    }

    // Log audit event
    await logAuditEvent({
      userId: adminId,
      action: "user_password_reset",
      entityType: "user",
      entityId: id,
      beforeState: null,
      afterState: { email: user.email }
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Error resetting password:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

export default router;

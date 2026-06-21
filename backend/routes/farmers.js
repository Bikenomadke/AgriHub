import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { encrypt, decrypt, encryptObject, decryptObject, hashIdentifier } from "../utils/encryption.js";

const router = Router();
router.use(authenticate);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function validateKenyaPhone(phone) {
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 10) return "254" + cleaned.slice(1);
  if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith("+254") && cleaned.length === 13) return cleaned.slice(1);
  return null;
}

function validateNationalID(id) {
  const cleaned = id.replace(/\D/g, "");
  return cleaned.length === 8 ? cleaned : null;
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── POST /api/farmers/register ──────────────────────────────────────────────
router.post("/register", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const { full_name, national_id, mpesa_phone, alternate_phone, county, subcounty, ward } = req.body;
    
    if (!full_name || !national_id || !mpesa_phone || !county || !subcounty || !ward) {
      return res.status(400).json({ error: "All required fields must be provided" });
    }

    const formattedPhone = validateKenyaPhone(mpesa_phone);
    if (!formattedPhone) return res.status(400).json({ error: "Invalid M-Pesa phone number format" });

    const formattedNationalID = validateNationalID(national_id);
    if (!formattedNationalID) return res.status(400).json({ error: "Invalid National ID format" });

    // Check for duplicates using hashed identifiers
    const nationalIdHash = hashIdentifier(formattedNationalID);
    const phoneHash = hashIdentifier(formattedPhone);
    
    const existing = await queryOne("SELECT id FROM agrihub.farmers WHERE national_id_hash = $1 OR mpesa_phone_hash = $2", [nationalIdHash, phoneHash]);
    if (existing) {
      return res.status(409).json({ error: "Farmer with this National ID or M-Pesa phone already exists" });
    }

    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const id = uuid();
    
    // Encrypt sensitive fields
    const encryptedNationalId = encrypt(formattedNationalID);
    const encryptedMpesaPhone = encrypt(formattedPhone);
    const encryptedAlternatePhone = alternate_phone ? encrypt(alternate_phone) : null;
    
    await pool.query(
      `INSERT INTO agrihub.farmers (id, full_name, national_id, mpesa_phone, alternate_phone, county, subcounty, ward, otp_code, otp_expires_at, verification_status, national_id_hash, mpesa_phone_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)`,
      [id, full_name, encryptedNationalId, encryptedMpesaPhone, encryptedAlternatePhone, county, subcounty, ward, otp, otpExpiresAt, nationalIdHash, phoneHash]
    );

    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [id]);
    
    // Decrypt sensitive fields for response
    const decryptedFarmer = decryptObject(farmer, ['national_id', 'mpesa_phone', 'alternate_phone']);

    res.status(201).json({ 
      farmer: { ...decryptedFarmer, otp_code: undefined },
      otp, // In production, send via SMS
      message: "OTP sent to phone number for verification"
    });
  } catch (err) {
    console.error("Farmer registration error:", err);
    res.status(500).json({ error: "Failed to register farmer" });
  }
});

// ─── POST /api/farmers/verify-otp ───────────────────────────────────────────────
router.post("/verify-otp", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const { farmer_id, otp } = req.body;
    
    if (!farmer_id || !otp) {
      return res.status(400).json({ error: "Farmer ID and OTP required" });
    }

    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [farmer_id]);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });

    if (farmer.verification_status === "verified") {
      return res.status(400).json({ error: "Farmer already verified" });
    }

    if (farmer.otp_code !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (new Date(farmer.otp_expires_at) < new Date()) {
      return res.status(400).json({ error: "OTP expired" });
    }

    await pool.query(
      `UPDATE agrihub.farmers 
      SET verification_status = 'verified', 
          otp_code = NULL, 
          otp_expires_at = NULL,
          mpesa_registered = true,
          updated_at = NOW()
      WHERE id = $1`,
      [farmer_id]
    );

    const updated = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [farmer_id]);
    res.json({ farmer: { ...updated, otp_code: undefined } });
  } catch (err) {
    console.error("OTP verification error:", err);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// ─── POST /api/farmers/resend-otp ───────────────────────────────────────────────
router.post("/resend-otp", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const { farmer_id } = req.body;
    
    if (!farmer_id) {
      return res.status(400).json({ error: "Farmer ID required" });
    }

    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [farmer_id]);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });

    if (farmer.verification_status === "verified") {
      return res.status(400).json({ error: "Farmer already verified" });
    }

    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await pool.query(
      `UPDATE agrihub.farmers 
      SET otp_code = $1, 
          otp_expires_at = $2,
          updated_at = NOW()
      WHERE id = $3`,
      [otp, otpExpiresAt, farmer_id]
    );

    res.json({ otp, message: "New OTP sent" });
  } catch (err) {
    console.error("Resend OTP error:", err);
    res.status(500).json({ error: "Failed to resend OTP" });
  }
});

// ─── GET /api/farmers ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { status, county, search } = req.query;
    let query = "SELECT * FROM agrihub.farmers WHERE 1=1";
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND verification_status = $${paramIndex++}`;
      params.push(status);
    }
    if (county) {
      query += ` AND county = $${paramIndex++}`;
      params.push(county);
    }
    if (search) {
      // Search by name only (sensitive fields are encrypted)
      query += ` AND full_name LIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    query += " ORDER BY created_at DESC";
    const farmers = await queryMany(query, params);
    
    // Decrypt sensitive fields for response
    const decryptedFarmers = farmers.map(f => {
      const decrypted = decryptObject(f, ['national_id', 'mpesa_phone', 'alternate_phone']);
      return { ...decrypted, otp_code: undefined };
    });
    
    res.json(decryptedFarmers);
  } catch (error) {
    console.error("Error fetching farmers:", error);
    res.status(500).json({ error: "Failed to fetch farmers" });
  }
});

// ─── GET /api/farmers/:id ─────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const farmer = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [req.params.id]);
    if (!farmer) return res.status(404).json({ error: "Farmer not found" });
    
    // Decrypt sensitive fields for response
    const decryptedFarmer = decryptObject(farmer, ['national_id', 'mpesa_phone', 'alternate_phone']);
    res.json({ ...decryptedFarmer, otp_code: undefined });
  } catch (error) {
    console.error("Error fetching farmer:", error);
    res.status(500).json({ error: "Failed to fetch farmer" });
  }
});

// ─── PUT /api/farmers/:id ──────────────────────────────────────────────────────
router.put("/:id", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const existing = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Farmer not found" });

    const { full_name, alternate_phone, county, subcounty, ward, verification_status } = req.body;
    
    let encryptedAlternatePhone = existing.alternate_phone;
    let phoneHash = existing.mpesa_phone_hash;
    
    if (alternate_phone && alternate_phone !== existing.alternate_phone) {
      const formattedPhone = validateKenyaPhone(alternate_phone);
      if (formattedPhone) {
        encryptedAlternatePhone = encrypt(formattedPhone);
        phoneHash = hashIdentifier(formattedPhone);
      }
    }
    
    await pool.query(
      `UPDATE agrihub.farmers 
      SET full_name = COALESCE($1, full_name),
          alternate_phone = COALESCE($2, alternate_phone),
          mpesa_phone_hash = COALESCE($3, mpesa_phone_hash),
          county = COALESCE($4, county),
          subcounty = COALESCE($5, subcounty),
          ward = COALESCE($6, ward),
          verification_status = COALESCE($7, verification_status),
          updated_at = NOW()
      WHERE id = $8`,
      [full_name, encryptedAlternatePhone, phoneHash, county, subcounty, ward, verification_status, req.params.id]
    );

    const updated = await queryOne("SELECT * FROM agrihub.farmers WHERE id = $1", [req.params.id]);
    
    // Decrypt sensitive fields for response
    const decryptedFarmer = decryptObject(updated, ['national_id', 'mpesa_phone', 'alternate_phone']);
    res.json({ ...decryptedFarmer, otp_code: undefined });
  } catch (err) {
    console.error("Farmer update error:", err);
    res.status(500).json({ error: "Failed to update farmer" });
  }
});

// ─── DELETE /api/farmers/:id ───────────────────────────────────────────────────
router.delete("/:id", authorize("Admin"), async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM agrihub.farmers WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Farmer not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Farmer deletion error:", err);
    res.status(500).json({ error: "Failed to delete farmer" });
  }
});

export default router;

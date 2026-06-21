/**
 * Migration Script: Encrypt Existing Farmer Data
 * 
 * This script encrypts existing PII in the farmers table:
 * - national_id
 * - mpesa_phone
 * - alternate_phone
 * 
 * Run this script after deploying the encryption changes to encrypt existing data.
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { encrypt, hashIdentifier } from "../utils/encryption.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "../agrihub.db"));

console.log("Starting migration: Encrypt existing farmer data...");

try {
  // Get all farmers
  const farmers = db.prepare("SELECT * FROM farmers").all();
  console.log(`Found ${farmers.length} farmers to migrate`);

  let migrated = 0;
  let errors = 0;

  for (const farmer of farmers) {
    try {
      // Skip if already encrypted (check if national_id starts with 'enc:')
      if (farmer.national_id && farmer.national_id.startsWith('enc:')) {
        console.log(`Skipping farmer ${farmer.id} - already encrypted`);
        continue;
      }

      // Encrypt sensitive fields
      const encryptedNationalId = farmer.national_id ? encrypt(farmer.national_id) : null;
      const encryptedMpesaPhone = farmer.mpesa_phone ? encrypt(farmer.mpesa_phone) : null;
      const encryptedAlternatePhone = farmer.alternate_phone ? encrypt(farmer.alternate_phone) : null;
      
      // Generate hash identifiers for searching
      const nationalIdHash = farmer.national_id ? hashIdentifier(farmer.national_id) : null;
      const mpesaPhoneHash = farmer.mpesa_phone ? hashIdentifier(farmer.mpesa_phone) : null;

      // Update farmer record
      db.prepare(`
        UPDATE farmers 
        SET national_id = ?,
            mpesa_phone = ?,
            alternate_phone = ?,
            national_id_hash = ?,
            mpesa_phone_hash = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(encryptedNationalId, encryptedMpesaPhone, encryptedAlternatePhone, nationalIdHash, mpesaPhoneHash, farmer.id);

      migrated++;
      console.log(`Migrated farmer ${farmer.id}: ${farmer.full_name}`);
    } catch (error) {
      console.error(`Failed to migrate farmer ${farmer.id}:`, error.message);
      errors++;
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total: ${farmers.length}`);

  if (errors > 0) {
    console.warn(`WARNING: ${errors} errors occurred during migration`);
    process.exit(1);
  } else {
    console.log(`SUCCESS: All farmers migrated successfully`);
    process.exit(0);
  }
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}

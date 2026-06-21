import { Router } from "express";
import { v4 as uuid } from "uuid";
import pool, { queryOne, queryMany } from "../db-postgres.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();

router.use(authenticate);

// GET /api/fields
router.get("/", async (req, res) => {
  try {
    const fields = await queryMany("SELECT * FROM agrihub.fields ORDER BY created_at DESC");
    const unlocks = await queryMany("SELECT field_id FROM agrihub.analysis_unlocks WHERE user_id = $1 AND status = 'completed'", [req.user.id]);
    const unlockedSet = new Set(unlocks.map(u => u.field_id));
    
    const parsed = fields.map(f => {
      const isUnlocked = req.user.role === 'Admin' || unlockedSet.has(f.id);
      return {
        ...f,
        polygon: f.polygon ? JSON.parse(f.polygon) : null,
        sites: f.sites || [],
        harvest: f.harvest || null,
        locked: !isUnlocked,
        ...(isUnlocked ? {} : {
          estimated_total_tons: 0,
          valuation: 0,
          harvest_cost: 0,
          transport_cost: 0,
          pulling_cost: 0,
          buying_price_per_acre: 0
        })
      };
    });
    res.json(parsed);
  } catch (error) {
    console.error("Error fetching fields:", error);
    res.status(500).json({ error: "Failed to fetch fields" });
  }
});

// GET /api/fields/:id
router.get("/:id", async (req, res) => {
  try {
    const f = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [req.params.id]);
    if (!f) return res.status(404).json({ error: "Field not found" });
    f.polygon = f.polygon ? JSON.parse(f.polygon) : null;
    f.sites = f.sites || [];
    f.harvest = f.harvest || null;

    const unlock = await queryOne("SELECT id FROM agrihub.analysis_unlocks WHERE user_id = $1 AND field_id = $2 AND status = 'completed'", [req.user.id, f.id]);
    const isUnlocked = req.user.role === 'Admin' || !!unlock;
    f.locked = !isUnlocked;
    if (!isUnlocked) {
      f.estimated_total_tons = 0;
      f.valuation = 0;
      f.harvest_cost = 0;
      f.transport_cost = 0;
      f.pulling_cost = 0;
      f.buying_price_per_acre = 0;
    }
    
    res.json(f);
  } catch (error) {
    console.error("Error fetching field:", error);
    res.status(500).json({ error: "Failed to fetch field" });
  }
});

// POST /api/fields
router.post("/", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const { name, area_acres, estimated_total_tons, buying_price_per_acre, polygon, avg_nodes, avg_stalks, survey_date, farmer_signature, sites, harvest } = req.body;
    if (!name) return res.status(400).json({ error: "Field name required" });

    const id = uuid();
    
    // Convert polygon to PostGIS geometry if provided
    let polygonGeometry = null;
    if (polygon && Array.isArray(polygon) && polygon.length >= 3) {
      const geojson = {
        type: "Polygon",
        coordinates: [polygon.map(coord => [coord[1], coord[0]])] // Swap lat/lng to lng/lat
      };
      const result = await pool.query(
        `SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) as geom`,
        [JSON.stringify(geojson)]
      );
      polygonGeometry = result.rows[0].geom;
    }

    await pool.query(
      `INSERT INTO agrihub.fields (id, name, area_acres, estimated_total_tons, buying_price_per_acre, polygon, avg_nodes, avg_stalks, survey_date, farmer_signature, sites, harvest, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id, name, area_acres || 0, estimated_total_tons || 0, buying_price_per_acre || null,
        polygonGeometry, avg_nodes || 12, avg_stalks || 8,
        survey_date || new Date().toISOString().slice(0, 10), farmer_signature || null,
        sites ? JSON.stringify(sites) : "[]", harvest ? JSON.stringify(harvest) : null,
        req.user.id
      ]
    );
    
    const field = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [id]);
    res.status(201).json(field);
  } catch (error) {
    console.error("Error creating field:", error);
    res.status(500).json({ error: "Failed to create field", details: error.message });
  }
});

// PUT /api/fields/:id
router.put("/:id", authorize("Admin", "Field Officer"), async (req, res) => {
  try {
    const existing = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Field not found" });

    const { name, area_acres, estimated_total_tons, buying_price_per_acre, polygon, avg_nodes, avg_stalks, survey_date, farmer_signature, sites, harvest } = req.body;
    
    // Convert polygon to PostGIS geometry if provided
    let polygonGeometry = existing.polygon;
    if (polygon && Array.isArray(polygon) && polygon.length >= 3) {
      const geojson = {
        type: "Polygon",
        coordinates: [polygon.map(coord => [coord[1], coord[0]])] // Swap lat/lng to lng/lat
      };
      const result = await pool.query(
        `SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) as geom`,
        [JSON.stringify(geojson)]
      );
      polygonGeometry = result.rows[0].geom;
    }

    await pool.query(
      `UPDATE agrihub.fields SET name=$1, area_acres=$2, estimated_total_tons=$3, buying_price_per_acre=$4, polygon=$5, avg_nodes=$6, avg_stalks=$7, survey_date=$8, farmer_signature=$9, sites=$10, harvest=$11, updated_at=NOW() WHERE id=$12`,
      [
        name ?? existing.name, area_acres ?? existing.area_acres, estimated_total_tons ?? existing.estimated_total_tons,
        buying_price_per_acre ?? existing.buying_price_per_acre,
        polygonGeometry,
        avg_nodes ?? existing.avg_nodes, avg_stalks ?? existing.avg_stalks,
        survey_date ?? existing.survey_date, farmer_signature ?? existing.farmer_signature,
        sites ? JSON.stringify(sites) : existing.sites, harvest ? JSON.stringify(harvest) : existing.harvest,
        req.params.id
      ]
    );
    
    const field = await queryOne("SELECT * FROM agrihub.fields WHERE id = $1", [req.params.id]);
    field.polygon = field.polygon ? JSON.parse(field.polygon) : null;
    field.sites = field.sites || [];
    field.harvest = field.harvest || null;
    res.json(field);
  } catch (error) {
    console.error("Error updating field:", error);
    res.status(500).json({ error: "Failed to update field" });
  }
});

// DELETE /api/fields/:id
router.delete("/:id", authorize("Admin"), async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM agrihub.fields WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Field not found" });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting field:", error);
    res.status(500).json({ error: "Failed to delete field" });
  }
});

// GET /api/fields/:id/analysis
router.get("/:id/analysis", async (req, res) => {
  try {
    const fieldId = req.params.id;
    const userId = req.user.id;

    const field = await queryOne(
      `SELECT id, name, area_acres, estimated_total_tons, buying_price_per_acre, 
              avg_nodes, avg_stalks, valuation, harvest_cost, transport_cost, pulling_cost
       FROM agrihub.fields 
       WHERE id = $1 AND deleted_at IS NULL`,
      [fieldId]
    );

    if (!field) {
      return res.status(404).json({ error: "Field not found" });
    }

    // Check if user has unlocked the analysis for this field
    const unlock = await queryOne(
      `SELECT id, status, expires_at 
       FROM agrihub.analysis_unlocks 
       WHERE user_id = $1 AND field_id = $2 AND status = 'completed' 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId, fieldId]
    );

    const isUnlocked = !!unlock;

    // Basic calculations (always available)
    const acreage = field.area_acres || 0;
    const stalkCount = (acreage * field.avg_nodes * field.avg_stalks) || 0;

    // Premium calculations (only available if unlocked)
    let estimatedYield = null;
    let farmerPayment = null;
    let expectedProfit = null;
    let transportCost = null;

    if (isUnlocked) {
      // Calculate premium values
      estimatedYield = field.estimated_total_tons || 0;
      farmerPayment = field.valuation || (field.area_acres * field.buying_price_per_acre) || 0;
      transportCost = field.transport_cost || 0;
      const harvestCost = field.harvest_cost || 0;
      const pullingCost = field.pulling_cost || 0;
      expectedProfit = farmerPayment - harvestCost - transportCost - pullingCost;
    }

    res.json({
      fieldId: field.id,
      fieldName: field.name,
      acreage,
      stalkCount,
      locked: !isUnlocked,
      ...(isUnlocked ? {
        estimatedYield,
        farmerPayment,
        expectedProfit,
        transportCost
      } : {})
    });
  } catch (error) {
    console.error("Error fetching field analysis:", error);
    res.status(500).json({ error: "Failed to fetch field analysis" });
  }
});

export default router;

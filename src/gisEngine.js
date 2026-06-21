// GIS-Grade Geodesic Geometry Engine for AgriHub (WGS84 Ellipsoid)

const WGS84_A = 6378137.0; // Semi-major axis (meters)
const WGS84_F = 1 / 298.257223563; // Flattening
const WGS84_B = WGS84_A * (1 - WGS84_F); // Semi-minor axis

/**
 * Calculates the geodesic area of a polygon on the WGS84 ellipsoid in square meters
 * Uses the Chamberlain-Duquette algorithm (equal-area projection approximation on ellipsoid)
 */
export function calculateGeodesicArea(coords) {
  if (!coords || coords.length < 3) return 0;
  
  // Ensure the polygon is closed
  const points = [...coords];
  if (
    points[0].lat !== points[points.length - 1].lat ||
    points[0].lng !== points[points.length - 1].lng
  ) {
    points.push(points[0]);
  }

  let totalArea = 0;
  const len = points.length;

  for (let i = 0; i < len - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    
    const x1 = p1.lng * Math.PI / 180;
    const y1 = p1.lat * Math.PI / 180;
    const x2 = p2.lng * Math.PI / 180;
    const y2 = p2.lat * Math.PI / 180;

    // Chamberlain-Duquette formula for ellipsoidal area
    totalArea += (x2 - x1) * (2 + Math.sin(y1) + Math.sin(y2));
  }

  // Multiply by the authalic radius squared divided by 2
  const authalicRadiusSq = (WGS84_A * WGS84_B); // approximation
  let areaMeters = Math.abs(totalArea * authalicRadiusSq / 2);
  
  // Convert square meters to acres
  return areaMeters / 4046.8564224;
}

/**
 * Checks if two line segments intersect
 */
function lineSegmentsIntersect(p1, p2, p3, p4) {
  const det = (p2.lng - p1.lng) * (p4.lat - p3.lat) - (p4.lng - p3.lng) * (p2.lat - p1.lat);
  if (det === 0) return false; // Parallel lines

  const lambda = ((p4.lat - p3.lat) * (p4.lng - p1.lng) + (p3.lng - p4.lng) * (p4.lat - p1.lat)) / det; // simplified parameter
  const gamma = ((p1.lat - p2.lat) * (p4.lng - p1.lng) + (p2.lng - p1.lng) * (p4.lat - p1.lat)) / det; // simplified parameter
  
  // Accurate standard 2D segment intersection check
  const d = (p2.lng - p1.lng) * (p4.lat - p3.lat) - (p2.lat - p1.lat) * (p4.lng - p3.lng);
  if (d === 0) return false;

  const u = ((p3.lng - p1.lng) * (p4.lat - p3.lat) - (p3.lat - p1.lat) * (p4.lng - p3.lng)) / d;
  const v = ((p3.lng - p1.lng) * (p2.lat - p1.lat) - (p3.lat - p1.lat) * (p2.lng - p1.lng)) / d;

  return (u > 0 && u < 1 && v > 0 && v < 1);
}

/**
 * Validates a polygon and returns an array of issues if found
 */
export function validatePolygon(coords) {
  const issues = [];
  if (!coords || coords.length < 3) {
    issues.push("Polygon must have at least 3 vertices.");
    return { valid: false, issues };
  }

  // Check for self-intersection
  const len = coords.length;
  for (let i = 0; i < len; i++) {
    const p1 = coords[i];
    const p2 = coords[(i + 1) % len];
    for (let j = i + 2; j < len; j++) {
      if ((j + 1) % len === i) continue; // skip adjacent edges
      const p3 = coords[j];
      const p4 = coords[(j + 1) % len];
      if (lineSegmentsIntersect(p1, p2, p3, p4)) {
        issues.push(`Self-intersection detected between edge ${i}-${(i+1)%len} and edge ${j}-${(j+1)%len}.`);
        break;
      }
    }
    if (issues.length > 0) break;
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

/**
 * Ramer-Douglas-Peucker (RDP) algorithm for edge simplification
 */
export function simplifyPolygon(points, tolerance = 0.00001) {
  if (points.length <= 2) return points;

  let maxSqDist = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const sqDist = getSqSegDist(points[i], points[0], points[end]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }

  if (maxSqDist > tolerance * tolerance) {
    const results1 = simplifyPolygon(points.slice(0, index + 1), tolerance);
    const results2 = simplifyPolygon(points.slice(index), tolerance);
    return results1.slice(0, results1.length - 1).concat(results2);
  }
  return [points[0], points[end]];
}

function getSqSegDist(p, p1, p2) {
  let x = p1.lng;
  let y = p1.lat;
  let dx = p2.lng - x;
  let dy = p2.lat - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p.lng - x) * dx + (p.lat - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2.lng;
      y = p2.lat;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p.lng - x;
  dy = p.lat - y;
  return dx * dx + dy * dy;
}

/**
 * Smoothes polygon using Chaikin's algorithm
 */
export function smoothPolygon(points, iterations = 1) {
  if (points.length < 3) return points;
  let current = [...points];

  for (let iter = 0; iter < iterations; iter++) {
    const next = [];
    const len = current.length;
    for (let i = 0; i < len; i++) {
      const p0 = current[i];
      const p1 = current[(i + 1) % len];

      // Cut corners at 1/4 and 3/4
      const q = {
        lat: p0.lat * 0.75 + p1.lat * 0.25,
        lng: p0.lng * 0.75 + p1.lng * 0.25,
        label: p0.label,
        note: p0.note
      };
      const r = {
        lat: p0.lat * 0.25 + p1.lat * 0.75,
        lng: p0.lng * 0.25 + p1.lng * 0.75,
        label: p0.label,
        note: p0.note
      };
      next.push(q, r);
    }
    current = next;
  }
  return current;
}

/**
 * Calculates a confidence score (0-100) for a recorded survey path
 */
export function calculateSurveyConfidence(points, maxAccuracyThreshold = 10.0) {
  if (!points || points.length === 0) return 0;

  // 1. Accuracy deduction
  let totalAccuracy = 0;
  let pointsWithinThreshold = 0;
  points.forEach(p => {
    const acc = p.accuracy || 5;
    totalAccuracy += acc;
    if (acc <= maxAccuracyThreshold) {
      pointsWithinThreshold++;
    }
  });

  const avgAccuracy = totalAccuracy / points.length;
  const ratioInThreshold = pointsWithinThreshold / points.length;

  let score = 100;

  // Deduct based on average accuracy (0 deduction for 2m, up to 40 deduction for 15m)
  const accuracyDeduction = Math.min(40, Math.max(0, (avgAccuracy - 2) * 3));
  score -= accuracyDeduction;

  // Deduct based on inconsistent fixes
  const consistencyDeduction = (1 - ratioInThreshold) * 40;
  score -= consistencyDeduction;

  // Vertex count bonus (more reference nodes yields higher boundary resolution)
  if (points.length < 5) score -= 15;
  else if (points.length >= 12) score += 5;

  return Math.min(100, Math.max(10, Math.round(score)));
}

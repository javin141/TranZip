import { Router } from 'express';
import { reverseGeocode, searchPlaces } from '../lib/oneMapClient.js';

export const placesRouter = Router();

/** GET /api/places/search?q=bishan%20mrt - autocomplete for both search boxes. */
placesRouter.get('/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) {
      return res.json({ query, found: 0, results: [] });
    }
    const page = Number.parseInt(req.query.page, 10) || 1;
    const payload = await searchPlaces(query, page);
    return res.json({ query, ...payload });
  } catch (error) {
    return next(error);
  }
});

/** GET /api/places/reverse?lat=1.35&lng=103.84 - "use my current location". */
placesRouter.get('/reverse', async (req, res, next) => {
  try {
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: { message: 'lat and lng query parameters are required.' } });
    }
    const place = await reverseGeocode(latitude, longitude);
    return res.json({
      latitude,
      longitude,
      name: place?.name || 'Current location',
      address: place?.address || '',
      resolved: Boolean(place),
    });
  } catch (error) {
    return next(error);
  }
});
import { Router } from 'express';
import { getWeatherNear } from '../lib/weatherClient.js';

export const weatherRouter = Router();

const SINGAPORE_CENTER = { latitude: 1.3521, longitude: 103.8198 };

/**
 * GET /api/weather/now?lat=&lng= - current rain/heat conditions nearest to a
 * point (defaults to the city centre so the UI can show a status pill before
 * the user has picked an origin).
 */
weatherRouter.get('/now', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const point = Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : SINGAPORE_CENTER;
    const weather = await getWeatherNear(point);
    return res.json(weather);
  } catch (error) {
    return next(error);
  }
});

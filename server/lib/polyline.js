/**
 * Decodes Google/OTP encoded polylines (precision 5) as returned in
 * `leg.legGeometry.points` by the OneMap routing service.
 */

export function decodePolyline(encoded, precision = 5) {
  const points = [];
  if (typeof encoded !== 'string' || encoded.length === 0) return points;
  const factor = 10 ** precision;

  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index) - 63 - 1;
      index += 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < encoded.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index) - 63 - 1;
      index += 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < encoded.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([latitude / factor, longitude / factor]);
  }

  return points;
}

/** Encodes `[[lat, lng], ...]` back into an encoded polyline (used for map payloads). */
export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let output = '';
  let previousLat = 0;
  let previousLng = 0;

  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    chunk += String.fromCharCode(v + 63);
    return chunk;
  };

  for (const [lat, lng] of points) {
    const latValue = Math.round(lat * factor);
    const lngValue = Math.round(lng * factor);
    output += encodeValue(latValue - previousLat) + encodeValue(lngValue - previousLng);
    previousLat = latValue;
    previousLng = lngValue;
  }

  return output;
}

export function polylineLengthMeters(points) {
  const toRadians = (deg) => (deg * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [lat1, lng1] = points[i - 1];
    const [lat2, lng2] = points[i];
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    total += 2 * 6371000 * Math.asin(Math.sqrt(a));
  }
  return total;
}
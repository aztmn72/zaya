const baseUrl = process.argv[2] || "http://localhost:8787";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(`${path}: ${data.error || response.statusText}`);
  }
  return data;
}

const unique = Date.now();
const admin = await request("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({
    name: "ZAYA Admin Test",
    email: `admin-${unique}@zaya.test`,
    password: "test1234"
  })
});

if (admin.user.role !== "admin") throw new Error("first user is not admin");

const auth = { Authorization: `Bearer ${admin.token}` };
const claimed = await request("/api/devices/claim", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    name: "Pilot ESP32",
    pairingCode: "ZAYA-ABC123",
    localDeviceId: "zaya-ABC123"
  })
});

await request(`/api/devices/${claimed.device.id}/telemetry`, {
  method: "POST",
  headers: { "X-ZAYA-Device-Secret": claimed.cloudProvisioning.cloudSecret },
  body: JSON.stringify({
    device: "zaya-ABC123",
    firmware: "0.3.0-pilot",
    max_zones: 16,
    free_zones: 4
  })
});

await request("/api/admin/users", { headers: auth });
await request("/api/admin/devices", { headers: auth });
await request(`/api/admin/users/${admin.user.id}/grant`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ plan: "pro" })
});

const me = await request("/api/me", { headers: auth });
if (me.user.zoneLimit !== 16) throw new Error("grant did not update zone limit");

console.log("ZAYA backend smoke-test passed");

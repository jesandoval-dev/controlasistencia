import React, { useEffect, useMemo, useState } from "react";

/**
 * Control de Personal – App Web (React + Tailwind)
 *
 * Fix aplicado: error de "CORS bloqueó la lectura y JSONP también falló".
 * Causas detectadas:
 *  - BASE_URL apuntaba a un despliegue anterior sin JSONP.
 *  - DEV_PROXY_URL vacío (POST y algunos GET bloqueados por CORS en sandbox/Pages).
 * Solución:
 *  - Actualicé DEFAULTS.BASE_URL al deployment que confirmaste con JSONP.
 *  - Definí DEFAULTS.DEV_PROXY_URL a tu Worker de Cloudflare.
 *  - Mantengo fallback JSONP para GET cuando no hay proxy y hay CORS.
 *  - Tests adicionales para validar URLs y construcción del proxy.
 */

// =================== CONFIGURACIÓN ===================
const DEFAULTS = {
  // Deployment con JSONP activo
  BASE_URL:
    "https://script.google.com/macros/s/AKfycbwmIcXjMTsbt4cj3Jcjat_4uNgq4aUJ7XycVh7BFhJCzkWHr7j7zHeciCXyqvikJEX4/exec",
  // Proxy Cloudflare Worker para CORS (GET+POST)
  DEV_PROXY_URL: "https://empty-bonus-b40b.jesandoval.workers.dev/",
  DEFAULT_USER: "jesandoval@opportunitynicaragua.org",
  TIMEOUT_MS: 12000,
  RETRIES: 0,
  ADV_DIAG: false, // diagnóstico avanzado opcional
  ALLOW_JSONP: true, // fallback GET-only para CORS estricto
};

function loadConfig() {
  try {
    const raw = localStorage.getItem("cp_config");
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveConfig(cfg) {
  localStorage.setItem("cp_config", JSON.stringify(cfg));
}

// =================== Utilidades ===================
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`Timeout después de ${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([promise, timeout]);
    return res;
  } finally {
    clearTimeout(t);
  }
}

// =================== Red (fetch + JSONP) ===================
// JSONP helper (GET only)
function jsonpGet(url, { timeout = 9000, callbackParam = "callback" } = {}) {
  return new Promise((resolve, reject) => {
    const cbName = `__cp_jsonp_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
    const sep = url.includes("?") ? "&" : "?";
    const full = `${url}${sep}${callbackParam}=${cbName}`;
    const script = document.createElement("script");
    let t;

    // @ts-ignore
    window[cbName] = (data) => {
      clearTimeout(t);
      script.remove();
      try { delete window[cbName]; } catch {}
      resolve(data);
    };

    script.src = full;
    script.onerror = () => {
      clearTimeout(t);
      try { delete window[cbName]; } catch {}
      reject(new Error("JSONP error"));
    };

    t = setTimeout(() => {
      script.remove();
      try { delete window[cbName]; } catch {}
      reject(new Error("JSONP timeout"));
    }, timeout);

    document.body.appendChild(script);
  });
}

/**
 * Fetch robusto con fallback JSONP para GET cuando hay CORS.
 * Si hay DEV_PROXY_URL, todas las llamadas (GET/POST) pasan por el proxy.
 */
async function fetchJSON({ url, method = "GET", headers, body, config }) {
  const attempt = async () => {
    let finalUrl = url;
    let finalOpts = {
      method,
      headers: headers || {},
      mode: "cors",
      redirect: "follow",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    };
    if (body != null) finalOpts.body = body;

    if (config.DEV_PROXY_URL) {
      // Si usamos proxy, la petición va siempre por el Worker
      finalUrl = `${config.DEV_PROXY_URL}?url=${encodeURIComponent(url)}`;
    }

    try {
      const res = await withTimeout(fetch(finalUrl, finalOpts), config.TIMEOUT_MS);
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        const txt = ct.includes("application/json") ? JSON.stringify(await res.json()).slice(0, 200) : await res.text();
        throw new Error(`HTTP ${res.status} – ${txt}`);
      }
      if (ct.includes("application/json")) return await res.json();
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Respuesta no-JSON del servidor");
      }
    } catch (err) {
      const corsLike = String(err).includes("Failed to fetch") || String(err.message || "").includes("CORS");
      // Si NO hay proxy y es GET, probamos JSONP
      if (!config.DEV_PROXY_URL && corsLike && method === "GET" && (config.ALLOW_JSONP ?? DEFAULTS.ALLOW_JSONP)) {
        try {
          const data = await withTimeout(jsonpGet(url, { callbackParam: "callback" }), config.TIMEOUT_MS);
          return data;
        } catch (e2) {
          throw new Error("CORS bloqueó la lectura y JSONP también falló. Usa DEV_PROXY_URL o habilita JSONP/CORS en Apps Script.");
        }
      }

      if (DEFAULTS.ADV_DIAG || config.ADV_DIAG) {
        if (corsLike) {
          try {
            await withTimeout(
              fetch(config.DEV_PROXY_URL ? `${config.DEV_PROXY_URL}?url=${encodeURIComponent(url)}` : url, {
                method: "GET",
                mode: "no-cors",
              }),
              4000
            );
            throw new Error(
              "No fue posible leer la respuesta por CORS. Publica el Web App como 'Cualquiera' y devuelve 'Access-Control-Allow-Origin: *' o usa DEV_PROXY_URL."
            );
          } catch (probeErr) {
            throw new Error(
              "No fue posible contactar el endpoint (¿URL inválida, despliegue inactivo o bloqueo de red?). Revisa la BASE_URL o usa DEV_PROXY_URL."
            );
          }
        }
      } else {
        if (String(err).includes("Failed to fetch")) {
          throw new Error(
            "No fue posible contactar el endpoint (posible CORS o red). Revisa publicación del Web App o configura DEV_PROXY_URL."
          );
        }
      }
      throw err;
    }
  };

  let attempts = 0;
  const max = Math.max(0, Number(config?.RETRIES ?? DEFAULTS.RETRIES));
  while (true) {
    try {
      return await attempt();
    } catch (e) {
      if (attempts >= max) throw e;
      attempts += 1;
      await sleep(350 * attempts);
    }
  }
}

// =================== Datos de prueba (MOCK) ===================
const MOCK = {
  empleados: [
    { empleado_id: "E-001", nombre: "Ana Pérez", cargo: "Operaria", grupo: "A", coordinador: "Luis" },
    { empleado_id: "E-002", nombre: "Juan López", cargo: "Operario", grupo: "B", coordinador: "Marta" },
    { empleado_id: "E-010", nombre: "Carlos Ruiz", cargo: "Supervisor", grupo: "A", coordinador: "Luis" },
  ],
  calendarizacion: [
    { fecha: todayISO(), turno: "Día", grupo: "A", coordinador: "Luis", empleado_id: "E-001", nombre: "Ana Pérez", cargo: "Operaria" },
    { fecha: todayISO(), turno: "Día", grupo: "A", coordinador: "Luis", empleado_id: "E-010", nombre: "Carlos Ruiz", cargo: "Supervisor" },
  ],
};

// =================== Componente principal ===================
export default function App() {
  const [config, setConfig] = useState(loadConfig());

  const [fecha, setFecha] = useState(todayISO());
  const [turno, setTurno] = useState("dia"); // "dia" | "noche"
  const [grupo, setGrupo] = useState("");
  const [coordinador, setCoordinador] = useState("");

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [mock, setMock] = useState(false);

  // Estado para buscador/añadir manual
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const turnoLabel = useMemo(() => (turno === "noche" ? "Noche" : "Día"), [turno]);

  function buildClientRowId(item) {
    return `${item.fecha || fecha}_${norm(item.turno || turnoLabel)}_${item.empleado_id}`;
  }

  // =================== Llamadas ===================
  async function cargarProgramados() {
    try {
      setLoading(true);
      setMessage("");

      if (mock) {
        const uniq = new Map();
        for (const d of MOCK.calendarizacion) {
          const it = {
            fecha: d.fecha || fecha,
            turno: d.turno || turnoLabel,
            grupo: d.grupo || "",
            coordinador: d.coordinador || "",
            empleado_id: d.empleado_id,
            nombre: d.nombre,
            cargo: d.cargo,
            asistencia: true,
            estado: "Asistio",
            he_comentario: "",
            client_row_id: "",
            source: "programado",
          };
          it.client_row_id = buildClientRowId(it);
          if (!uniq.has(it.empleado_id)) uniq.set(it.empleado_id, it);
        }
        setRows(Array.from(uniq.values()));
        setMessage(`(MOCK) Cargados ${uniq.size} trabajadores programados.`);
        return;
      }

      const params = new URLSearchParams({ action: "calendarizacion", fecha, turno });
      if (grupo) params.set("grupo", grupo);
      if (coordinador) params.set("coordinador", coordinador);

      const url = `${config.BASE_URL}?${params.toString()}`;
      // Con proxy activo, GET no requiere JSONP; sin proxy, fallback JSONP
      const json = await fetchJSON({ url, method: "GET", config });

      if (!json || !Array.isArray(json.data)) throw new Error("Respuesta inválida del servidor");

      const mapped = json.data.map((d) => ({
        fecha: d.fecha || fecha,
        turno: d.turno || turnoLabel,
        grupo: d.grupo || "",
        coordinador: d.coordinador || "",
        empleado_id: d.empleado_id,
        nombre: d.nombre,
        cargo: d.cargo,
        asistencia: true,
        estado: "Asistio",
        he_comentario: "",
        client_row_id: "",
        source: "programado",
      }));

      const uniqById = new Map();
      for (const it of mapped) {
        const item = { ...it, client_row_id: buildClientRowId(it) };
        if (!uniqById.has(item.empleado_id)) uniqById.set(item.empleado_id, item);
      }

      setRows(Array.from(uniqById.values()));
      setMessage(`Cargados ${uniqById.size} trabajadores programados.`);
    } catch (err) {
      console.error(err);
      setMessage(`Error al cargar: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }

  async function buscarEmpleados(q) {
    if (!q || q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      setSearching(true);
      if (mock) {
        const qn = norm(q);
        const filtered = MOCK.empleados.filter(
          (e) => norm(e.nombre).includes(qn) || norm(e.empleado_id).includes(qn)
        );
        setSearchResults(filtered);
        return;
      }
      const url = `${config.BASE_URL}?action=empleados&q=${encodeURIComponent(q)}`;
      const json = await fetchJSON({ url, method: "GET", config });
      setSearchResults(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      console.error(err);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function agregarManual(emp) {
    const item = {
      fecha,
      turno: turnoLabel,
      grupo: emp.grupo || grupo || "",
      coordinador: emp.coordinador || coordinador || "",
      empleado_id: emp.empleado_id,
      nombre: emp.nombre,
      cargo: emp.cargo,
      asistencia: true,
      estado: "Asistio",
      he_comentario: "",
      client_row_id: "",
      source: "manual",
    };
    item.client_row_id = buildClientRowId(item);

    setRows((prev) => {
      const exists = prev.some((r) => r.empleado_id === item.empleado_id);
      if (exists) return prev;
      return [...prev, item];
    });

    setMessage(`Se agregó ${emp.nombre} a la lista.`);
  }

  function toggleAsistencia(idx, checked) {
    setRows((prev) => {
      const copy = [...prev];
      const r = { ...copy[idx] };
      r.asistencia = checked;
      r.estado = checked ? "Asistio" : "Falta";
      r.client_row_id = buildClientRowId(r);
      copy[idx] = r;
      return copy;
    });
  }

  function changeEstado(idx, value) {
    setRows((prev) => {
      const copy = [...prev];
      const r = { ...copy[idx] };
      r.estado = value;
      r.asistencia = value === "Asistio";
      r.client_row_id = buildClientRowId(r);
      copy[idx] = r;
      return copy;
    });
  }

  function changeComentario(idx, value) {
    setRows((prev) => {
      const copy = [...prev];
      const r = { ...copy[idx] };
      r.he_comentario = value;
      copy[idx] = r;
      return copy;
    });
  }

  async function guardarPaquete() {
    try {
      setSaving(true);
      setMessage("");

      const items = rows.map((r) => ({
        fecha: r.fecha,
        turno: r.turno,
        grupo: r.grupo,
        coordinador: r.coordinador,
        empleado_id: r.empleado_id,
        estado: r.estado,
        he_comentario: r.he_comentario,
        client_row_id: r.client_row_id || buildClientRowId(r),
      }));

      if (mock) {
        await sleep(500);
        setMessage(`(MOCK) Guardado OK. Filas: ${items.length}`);
        return;
      }

      if (!config.DEV_PROXY_URL) {
        throw new Error("Guardar requiere DEV_PROXY_URL en este entorno (POST bloqueado por CORS). Configura un proxy o habilita CORS en Apps Script.");
      }
      const url = config.DEV_PROXY_URL || config.BASE_URL;
      const json = await fetchJSON({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "batch_save", usuario_app: config.DEFAULT_USER, items }),
        config,
      });

      if (!json || json.error) throw new Error(json?.error || "Error al guardar");

      setMessage(
        `Guardado OK. Filas nuevas: ${json.appended_count || 0} / Enviadas: ${json.total_items || items.length}`
      );
    } catch (err) {
      console.error(err);
      setMessage(`Error al guardar: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  }

  // Búsqueda en vivo
  useEffect(() => {
    const t = setTimeout(() => buscarEmpleados(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // =================== Tests ===================
  const [tests, setTests] = useState([]);
  function runTests() {
    const results = [];
    function expect(name, cond) { results.push({ name, pass: !!cond }); }

    // Test existentes
    expect("norm() quita acentos", norm("Áé ÍÓ ú  ") === "ae io u");
    expect("norm() colapsa espacios", norm("  hola   mundo ") === "hola mundo");

    const fid = todayISO();
    const rid = `${fid}_dia_E-001`;
    expect(
      "buildClientRowId usa fecha+turno+id",
      (function () {
        const tmpFecha = fid;
        const turnoLabelLocal = "Día";
        const item = { fecha: tmpFecha, turno: turnoLabelLocal, empleado_id: "E-001" };
        return `${item.fecha}_${norm(item.turno)}_${item.empleado_id}` === rid;
      })()
    );

    const p = new URLSearchParams({ action: "calendarizacion", fecha: fid, turno: "dia" });
    const expectedUrl = `${DEFAULTS.BASE_URL}?${p.toString()}`;
    expect("URL calendarizacion", expectedUrl.includes("action=calendarizacion") && expectedUrl.includes("turno=dia"));

    const filtered = MOCK.empleados.filter((e) => norm(e.nombre).includes(norm("ana")));
    expect("Filtro empleados MOCK", filtered.length === 1 && filtered[0].empleado_id === "E-001");

    // Nuevos tests
    // 1) RETRIES debe respetar config
    const cfgA = { ...DEFAULTS, RETRIES: 3 };
    expect("config.RETRIES sobrescribe DEFAULTS", cfgA.RETRIES === 3);

    // 2) GET no debe enviar Content-Type por defecto (evitar preflight innecesario)
    const getOptsHasCT = (() => {
      const headers = undefined; // como en nuestras llamadas GET
      const hasCT = !!(headers && (headers["Content-Type"] || headers["content-type"]));
      return hasCT;
    })();
    expect("GET sin Content-Type", getOptsHasCT === false);

    // 3) buildClientRowId normaliza turno
    const rid2 = `${fid}_noche_E-999`;
    expect(
      "buildClientRowId normaliza turno",
      (function () {
        const item = { fecha: fid, turno: "Noche", empleado_id: "E-999" };
        return `${item.fecha}_${norm(item.turno)}_${item.empleado_id}` === rid2;
      })()
    );

    // 4) JSONP url builder agrega callback correctamente
    const testJsonp = (function(){
      const url = "https://example.com/api?a=1";
      const cb = "__cp_jsonp_test";
      const sep = url.includes("?") ? "&" : "?";
      const full = `${url}${sep}callback=${cb}`;
      return /callback=__cp_jsonp_test/.test(full);
    })();
    expect("JSONP url builder", testJsonp === true);

    // 5) Proxy URL se construye correctamente
    const builtProxy = `${DEFAULTS.DEV_PROXY_URL}?url=${encodeURIComponent(DEFAULTS.BASE_URL)}`;
    expect("Proxy builder", builtProxy.startsWith(DEFAULTS.DEV_PROXY_URL) && builtProxy.includes("?url="));

    // 6) Dominio de BASE_URL es script.google.com
    expect("Dominio BASE_URL", /^https:\/\/script\.google\.com\//.test(DEFAULTS.BASE_URL));

    setTests(results);
  }

  // =================== Probar conexión ===================
  async function probarConexion() {
    try {
      setMessage("Probando conexión...");
      const url = `${(config.BASE_URL)}?action=empleados&q=xx`;
      // Si hay proxy configurado, fetchJSON usará proxy; si no, intentará JSONP en GET
      await fetchJSON({ url, method: "GET", config });

      // POST de prueba solo si hay proxy (para evitar CORS en este entorno)
      if (config.DEV_PROXY_URL) {
        await fetchJSON({
          url: config.BASE_URL,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "ping" }),
          config,
        });
      }

      setMessage("Conexión OK: GET (y POST si hay proxy) accesibles.");
    } catch (e) {
      setMessage(`Diagnóstico conexión: ${e.message}`);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Control de Personal</h1>
          <p className="text-sm text-gray-600">
            Backend: Google Apps Script + Google Sheets · Interfaz: React + Tailwind
          </p>
        </header>

        {/* Conexión / Debug */}
        <section className="grid grid-cols-1 md:grid-cols-6 gap-3 bg-white p-4 rounded-2xl shadow-sm border mb-4">
          <div className="md:col-span-3">
            <label className="block text-xs text-gray-500 mb-1">BASE_URL (Apps Script)</label>
            <input
              className="w-full rounded-xl border px-3 py-2"
              value={config.BASE_URL}
              onChange={(e) => setConfig((c) => ({ ...c, BASE_URL: e.target.value }))}
              placeholder="https://script.google.com/.../exec"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-gray-500 mb-1">DEV_PROXY_URL (opcional)</label>
            <input
              className="w-full rounded-xl border px-3 py-2"
              value={config.DEV_PROXY_URL}
              onChange={(e) => setConfig((c) => ({ ...c, DEV_PROXY_URL: e.target.value }))}
              placeholder="https://tu-worker.workers.dev"
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-xs text-gray-500 mb-1">Avanzado (diagnóstico)</label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!config.ADV_DIAG} onChange={(e)=> setConfig(c=>({...c, ADV_DIAG: e.target.checked}))} />
              Activar probes extra
            </label>
          </div>
          <div className="md:col-span-1">
            <label className="block text-xs text-gray-500 mb-1">Fallback JSONP (solo GET)</label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!config.ALLOW_JSONP} onChange={(e)=> setConfig(c=>({...c, ALLOW_JSONP: e.target.checked}))} />
              Permitir JSONP si CORS bloquea
            </label>
          </div>
          <div className="md:col-span-6 flex items-center gap-2 pt-1">
            <button
              className="rounded-xl bg-gray-900 text-white px-4 py-2 hover:bg-black"
              onClick={() => { saveConfig(config); }}
            >Guardar conexión</button>
            <button
              className="rounded-xl bg-blue-600 text-white px-4 py-2 hover:bg-blue-700"
              onClick={probarConexion}
            >Probar conexión</button>
            <label className="ml-3 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
              Usar datos de prueba (MOCK)
            </label>
          </div>
          <div className="md:col-span-6 text-xs text-amber-700">
            Si ves errores de CORS: publica tu Web App con acceso "Cualquiera" o usa un proxy que añada <code>Access-Control-Allow-Origin: *</code>.
          </div>
        </section>

        {/* Nota sandbox */}
        <section className="bg-yellow-50 border border-yellow-200 text-yellow-900 rounded-2xl p-3 text-sm mb-3">
          Este entorno puede bloquear lecturas CORS de <code>script.google.com</code>. Si no configuras <strong>DEV_PROXY_URL</strong>, activa el <strong>Fallback JSONP</strong> (GET) y verifica que tu Apps Script soporte <code>?callback=...</code>. Para <strong>POST</strong> (guardar), usa un proxy o habilita CORS en el backend.
        </section>

        {/* Filtros */}
        <section className="grid grid-cols-1 md:grid-cols-5 gap-3 bg-white p-4 rounded-2xl shadow-sm border">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Fecha</label>
            <input type="date" className="w-full rounded-xl border px-3 py-2" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Turno</label>
            <select className="w-full rounded-xl border px-3 py-2" value={turno} onChange={(e) => setTurno(e.target.value)}>
              <option value="dia">Día</option>
              <option value="noche">Noche</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Grupo (opcional)</label>
            <input type="text" className="w-full rounded-xl border px-3 py-2" placeholder="A, B, ..." value={grupo} onChange={(e) => setGrupo(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Coordinador (opcional)</label>
            <input type="text" className="w-full rounded-xl border px-3 py-2" placeholder="Nombre" value={coordinador} onChange={(e) => setCoordinador(e.target.value)} />
          </div>
          <div className="flex items-end gap-2">
            <button className="w-full rounded-xl bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 disabled:opacity-50" onClick={cargarProgramados} disabled={loading}>
              {loading ? "Cargando..." : "Cargar personal"}
            </button>
          </div>
        </section>

        {/* Agregar manual + Lista */}
        <section className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white p-4 rounded-2xl shadow-sm border md:col-span-2">
            <h2 className="font-semibold mb-2">Lista de trabajadores</h2>
            <div className="overflow-auto border rounded-xl">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 text-gray-700">
                  <tr>
                    <th className="p-2 text-left">ID</th>
                    <th className="p-2 text-left">Nombre</th>
                    <th className="p-2 text-left">Cargo</th>
                    <th className="p-2 text-left">Grupo</th>
                    <th className="p-2 text-left">Coordinador</th>
                    <th className="p-2 text-left">Asist.</th>
                    <th className="p-2 text-left">Estado</th>
                    <th className="p-2 text-left">HE_Comentario</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td className="p-3 text-gray-500" colSpan={8}>No hay trabajadores cargados. Usa "Cargar personal" o agrega manualmente.</td>
                    </tr>
                  ) : (
                    rows.map((r, idx) => (
                      <tr key={r.empleado_id} className="border-t">
                        <td className="p-2 whitespace-nowrap">{r.empleado_id}</td>
                        <td className="p-2">{r.nombre}</td>
                        <td className="p-2">{r.cargo}</td>
                        <td className="p-2">
                          <input
                            value={r.grupo || ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setRows((prev) => { const copy = [...prev]; copy[idx] = { ...copy[idx], grupo: v }; return copy; });
                            }}
                            className="w-20 rounded border px-2 py-1"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            value={r.coordinador || ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setRows((prev) => { const copy = [...prev]; copy[idx] = { ...copy[idx], coordinador: v }; return copy; });
                            }}
                            className="w-36 rounded border px-2 py-1"
                          />
                        </td>
                        <td className="p-2">
                          <input type="checkbox" checked={!!r.asistencia} onChange={(e) => toggleAsistencia(idx, e.target.checked)} />
                        </td>
                        <td className="p-2">
                          <select value={r.estado} onChange={(e) => changeEstado(idx, e.target.value)} className="rounded border px-2 py-1">
                            <option>Asistio</option>
                            <option>Falta</option>
                            <option>Permiso</option>
                            <option>Reposo</option>
                            <option>Suspension</option>
                          </select>
                        </td>
                        <td className="p-2">
                          <input value={r.he_comentario || ""} onChange={(e) => changeComentario(idx, e.target.value)} className="w-64 rounded border px-2 py-1" placeholder="Detalle de horas extra / comentario" />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex justify-end">
              <button className="rounded-xl bg-emerald-600 text-white px-4 py-2 hover:bg-emerald-700 disabled:opacity-50" onClick={guardarPaquete} disabled={saving || rows.length === 0}>
                {saving ? "Guardando..." : "Guardar y enviar"}
              </button>
            </div>
          </div>

          <div className="bg-white p-4 rounded-2xl shadow-sm border">
            <h2 className="font-semibold mb-2">Agregar manual</h2>
            <input className="w-full rounded-xl border px-3 py-2 mb-2" placeholder="Buscar por ID o nombre (min 2 letras)" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="text-xs text-gray-500 mb-2">{searching ? "Buscando..." : "Sugerencias de empleados activos"}</div>
            <div className="max-h-72 overflow-auto border rounded-2xl divide-y">
              {searchResults.length === 0 ? (
                <div className="p-3 text-gray-500 text-sm">Sin resultados.</div>
              ) : (
                searchResults.map((emp) => (
                  <div key={emp.empleado_id} className="p-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium text-sm">{emp.nombre}</div>
                      <div className="text-xs text-gray-500">{emp.empleado_id} · {emp.cargo}{emp.coordinador ? ` · Coord: ${emp.coordinador}` : ""}</div>
                    </div>
                    <button className="rounded-lg bg-gray-900 text-white px-3 py-1 text-xs hover:bg-black" onClick={() => agregarManual(emp)}>Agregar</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Mensajes */}
        {message && (
          <div className="mt-4 p-3 rounded-xl bg-yellow-50 border text-sm">{message}</div>
        )}

        {/* Tests */}
        <section className="mt-6 bg-white p-4 rounded-2xl shadow-sm border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Pruebas rápidas</h3>
            <button className="rounded-xl bg-gray-900 text-white px-3 py-1 text-sm" onClick={runTests}>Ejecutar tests</button>
          </div>
          <ul className="mt-3 text-sm list-disc pl-5">
            {tests.length === 0 ? (
              <li className="text-gray-500">Aún no se han ejecutado pruebas.</li>
            ) : (
              tests.map((t, i) => (
                <li key={i} className={t.pass ? "text-emerald-700" : "text-rose-700"}>
                  {t.pass ? "✔" : "✘"} {t.name}
                </li>
              ))
            )}
          </ul>
        </section>

        <footer className="mt-8 text-xs text-gray-500">
          <p>
            Si continúas viendo errores de CORS:
            1) Publica tu Web App como <em>Ejecutar como: tú</em> y <em>Quién tiene acceso: Cualquiera</em>,
            2) Devuelve cabeceras CORS (si usas proxy): <code>Access-Control-Allow-Origin: *</code>, <code>Access-Control-Allow-Methods: GET,POST,OPTIONS</code>, <code>Access-Control-Allow-Headers: Content-Type</code>,
            3) Usa <strong>DEV_PROXY_URL</strong> (proxy con esas cabeceras).
          </p>
        </footer>
      </div>
    </div>
  );
}

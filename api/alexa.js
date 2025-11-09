// api/alexa.js
import verifier from "alexa-verifier";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const ALEXA_VERIFY = String(process.env.ALEXA_VERIFY || "true").toLowerCase() === "true";

// ---------- helpers de resposta ----------
function alexaPlain(text, shouldEnd = true) {
  return {
    version: "1.0",
    response: {
      shouldEndSession: shouldEnd,
      outputSpeech: { type: "PlainText", text: String(text ?? "") },
    },
  };
}

function alexaSSML(ssml, shouldEnd = true) {
  // Garante <speak>...</speak>
  const clean = String(ssml ?? "").trim();
  const wrapped = clean.startsWith("<speak>") ? clean : `<speak>${clean}</speak>`;
  return {
    version: "1.0",
    response: {
      shouldEndSession: shouldEnd,
      outputSpeech: { type: "SSML", ssml: wrapped },
    },
  };
}

function alexaError(text = "Desculpe, houve um erro ao processar.") {
  return alexaSSML(`<speak>${text}</speak>`, true);
}

function buildAskPrompt() {
  return alexaSSML(
    "<speak>Oi! O que você quer saber?</speak>",
    false // mantém a sessão aberta
  );
}

// ---------- leitura de raw body ----------
async function getRawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------- verificação Alexa ----------
async function verifyAlexaRequest(req, rawBodyStr) {
  const signature = req.headers["signature"];
  const certUrl = req.headers["signaturecertchainurl"];

  // Logs pequenos para diagnosticar no Vercel
  console.log(
    "[verify] hasSig=%s hasCert=%s verify=%s",
    Boolean(signature),
    Boolean(certUrl),
    ALEXA_VERIFY
  );

  if (!ALEXA_VERIFY) return;

  if (!signature || !certUrl) {
    throw new Error("Missing signature or cert url");
  }

  // IMPORTANTE: passar STRING para o verifier (evita falsos negativos)
  await new Promise((resolve, reject) => {
    verifier(certUrl, signature, rawBodyStr, (err) => (err ? reject(err) : resolve()));
  });
}

// ---------- chamada ao Make ----------
async function askMake(query, sessionId) {
  if (!MAKE_WEBHOOK_URL) throw new Error("MAKE_WEBHOOK_URL is empty");

  const payload = {
    query: String(query || "").trim(),
    sessionId: String(sessionId || ""),
    source: "alexa",
  };

  // timeout de 8s para evitar travar a resposta
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let resp;
  try {
    resp = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("[make] bad status", resp.status, txt);
    throw new Error(`Make returned ${resp.status}`);
  }

  // Pode ser Alexa JSON completo OU um objeto com text/ssml
  let data;
  const rawText = await resp.text();
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    // fallback se Make retornar texto puro
    data = { text: rawText };
  }
  return data;
}

// ---------- handler principal ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const rawBody = await getRawBody(req);
    const rawBodyStr = rawBody.toString("utf8");

    // Log de entrada
    console.log("Incoming POST /api/alexa", {
      host: req.headers.host,
      ua: req.headers["user-agent"],
      hasSig: Boolean(req.headers["signature"]),
      hasCert: Boolean(req.headers["signaturecertchainurl"]),
      verifyEnabled: ALEXA_VERIFY,
      bodyLen: rawBody.length,
    });

    // 1) Verifica (se ativado)
    try {
      await verifyAlexaRequest(req, rawBodyStr);
    } catch (e) {
      console.error("Alexa verify failed:", e?.message || e);
      res.status(400).json(alexaPlain("Não foi possível validar a requisição."));
      return;
    }

    // 2) Parse do JSON
    let alexaReq;
    try {
      alexaReq = JSON.parse(rawBodyStr);
    } catch (e) {
      console.error("JSON parse failed:", e?.message || e);
      res.status(400).json(alexaError("Requisição inválida."));
      return;
    }

    const type = alexaReq.request?.type;
    const intent = alexaReq.request?.intent?.name;
    const query =
      alexaReq.request?.intent?.slots?.query?.value ||
      alexaReq.request?.intent?.slots?.SearchQuery?.value || // se você usar AMAZON.SearchQuery com nome SearchQuery
      "";

    // 3) Roteamento das intents
    if (type === "LaunchRequest") {
      res.status(200).json(buildAskPrompt());
      return;
    }

    if (type === "IntentRequest") {
      // Intent principal
      if (intent === "AskPerplexityIntent") {
        if (!query) {
          res
            .status(200)
            .json(alexaSSML("<speak>Qual é a sua pergunta?</speak>", false));
          return;
        }

        try {
          const r = await askMake(query, alexaReq.session?.sessionId || "");
          // Se o Make já devolver Alexa JSON (tem `version` e `response`)
          if (r && r.version && r.response) {
            res.status(200).json(r);
            return;
          }
          // Se devolveu um objeto simples
          if (r?.ssml) {
            res.status(200).json(alexaSSML(r.ssml, true));
            return;
          }
          if (r?.text) {
            res.status(200).json(alexaPlain(r.text, true));
            return;
          }
          // Qualquer outro formato: fallback
          res
            .status(200)
            .json(alexaPlain("Desculpe, não encontrei a resposta.", true));
          return;
        } catch (e) {
          console.error("Erro no handler/Make:", e?.message || e);
          res.status(200).json(alexaError());
          return;
        }
      }

      // Fallback para intents desconhecidas
      res
        .status(200)
        .json(alexaPlain("Desculpe, não entendi. Pode repetir?", false));
      return;
    }

    // Tipos não suportados
    res.status(200).json(alexaPlain("Ok.", true));
  } catch (e) {
    console.error("Erro no handler (fatal):", e?.stack || e);
    res.status(500).json(alexaError());
  }
}

// api/alexa.js
import verifier from "alexa-verifier";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const VERIFY = String(process.env.ALEXA_VERIFY || "true").toLowerCase() === "true";

function alexaResponseSSML(ssml, end = true) {
  return {
    version: "1.0",
    response: {
      shouldEndSession: end,
      outputSpeech: { type: "SSML", ssml }
    }
  };
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  const startedAt = Date.now();
  res.setHeader("X-Req-Id", requestId);

  try {
    if (req.method !== "POST") {
      console.warn(`[${requestId}] Method not allowed: ${req.method}`);
      return res.status(405).send("Method Not Allowed");
    }

    // Log de headers mínimos (sem dados sensíveis)
    console.log(`[${requestId}] Incoming POST /api/alexa`, {
      host: req.headers.host,
      ua: req.headers["user-agent"],
      hasSig: !!req.headers["signature"],
      hasCert: !!req.headers["signaturecertchainurl"]
    });

    const rawBody = await getRawBody(req);
    const signature = req.headers["signature"];
    const certUrl = req.headers["signaturecertchainurl"];

    if (VERIFY) {
      if (!signature || !certUrl) {
        console.error(`[${requestId}] Faltam headers de verificação`, {
          signaturePresent: !!signature,
          certUrlPresent: !!certUrl
        });
        return res
          .status(401)
          .json(alexaResponseSSML("<speak>Não foi possível validar a requisição.</speak>"));
      }

      try {
        await new Promise((resolve, reject) => {
          verifier(certUrl, signature, rawBody, (err) => (err ? reject(err) : resolve()));
        });
      } catch (e) {
        console.error(
          `[${requestId}] Alexa verify failed: ${e?.message || e}`,
          { certUrl, signaturePresent: !!signature }
        );
        return res
          .status(401)
          .json(alexaResponseSSML("<speak>Não foi possível validar a requisição.</speak>"));
      }
    }

    // Parse do corpo já verificado
    const alexaReq = JSON.parse(rawBody.toString("utf8"));
    const type = alexaReq.request?.type;
    const intent = alexaReq.request?.intent?.name;
    const slots = alexaReq.request?.intent?.slots || {};
    const query =
      slots?.query?.value ||
      slots?.pergunta?.value ||
      slots?.texto?.value ||
      "";

    console.log(`[${requestId}] Parsed`, { type, intent, query });

    // Launch
    if (type === "LaunchRequest") {
      console.log(`[${requestId}] LaunchRequest`);
      return res.status(200).json(
        alexaResponseSSML(
          "<speak>Oi! O que você quer saber?</speak>",
          false
        )
      );
    }

    // Intent principal
    if (type === "IntentRequest" && intent === "AskPerplexityIntent") {
      if (!MAKE_WEBHOOK_URL) {
        console.error(`[${requestId}] MAKE_WEBHOOK_URL ausente`);
        return res.status(500).json(
          alexaResponseSSML("<speak>Configuração ausente no servidor.</speak>")
        );
      }

      console.log(`[${requestId}] Enviando para Make:`, { query });

      let makeResp;
      try {
        const r = await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query })
        });

        const text = await r.text();
        try {
          makeResp = JSON.parse(text);
        } catch {
          makeResp = { text }; // se não for JSON, tratamos como texto cru
        }

        console.log(`[${requestId}] Make respondeu`, {
          status: r.status,
          keys: Object.keys(makeResp || {})
        });
      } catch (e) {
        console.error(`[${requestId}] Erro chamando Make:`, e);
        return res
          .status(200)
          .json(alexaResponseSSML("<speak>Desculpe, houve um erro ao processar.</speak>"));
      }

      // Se já veio no formato Alexa, devolvemos sem tocar
      if (makeResp && makeResp.version && makeResp.response) {
        console.log(`[${requestId}] Respondendo Alexa JSON do Make`);
        return res.status(200).json(makeResp);
      }

      // Caso contrário, tentamos montar SSML com campos usuais
      const text =
        makeResp?.ssml ||
        makeResp?.speech ||
        makeResp?.answer ||
        makeResp?.message ||
        makeResp?.text;

      if (!text || typeof text !== "string" || !text.trim()) {
        console.warn(`[${requestId}] Make retornou vazio/inválido`, { makeResp });
        return res
          .status(200)
          .json(alexaResponseSSML("<speak>Desculpe, não encontrei a resposta.</speak>"));
      }

      const ssml = text.trim().startsWith("<speak>")
        ? text.trim()
        : `<speak>${text.trim()}</speak>`;

      console.log(`[${requestId}] Respondendo SSML montado`);
      return res.status(200).json(alexaResponseSSML(ssml));
    }

    console.log(`[${requestId}] Tipo/intent não tratado`, { type, intent });
    return res
      .status(200)
      .json(alexaResponseSSML("<speak>Desculpe, não entendi.</speak>"));
  } catch (err) {
    console.error(`[${requestId}] Erro no handler:`, err);
    return res
      .status(200)
      .json(alexaResponseSSML("<speak>Desculpe, houve um erro ao processar.</speak>"));
  } finally {
    console.log(`[${requestId}] FIM em ${Date.now() - startedAt}ms`);
  }
}

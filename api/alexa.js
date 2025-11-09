// api/alexa.js
import verifier from "alexa-verifier";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const ALEXA_VERIFY = (process.env.ALEXA_VERIFY || "true").toLowerCase() !== "false";

// -----------------------------
// Helpers
// -----------------------------
function alexaResponse({ text, end = true }) {
  // Resposta mínima compatível com Alexa
  return {
    version: "1.0",
    response: {
      shouldEndSession: end,
      outputSpeech: {
        type: "SSML",
        ssml: `<speak>${text}</speak>`,
      },
    },
  };
}

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyAlexaSignature({ certUrl, signature, rawString }) {
  return new Promise((resolve, reject) => {
    // MUITO IMPORTANTE: enviar STRING CRUA para o alexa-verifier!
    verifier(certUrl, signature, rawString, (err) => (err ? reject(err) : resolve()));
  });
}

// -----------------------------
// Handler
// -----------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // 1) Leia o corpo cru ANTES de qualquer parse
  const rawBuffer = await readRawBody(req);
  const rawString = rawBuffer.toString("utf8"); // <-- chave para não quebrar a verificação
  const sig = req.headers["signature"];
  const certUrl = req.headers["signaturecertchainurl"];

  try {
    // 2) Verificação de assinatura (quando habilitada)
    if (ALEXA_VERIFY) {
      if (!sig || !certUrl) {
        console.log("[verify] missing headers", {
          hasSig: !!sig,
          hasCert: !!certUrl,
          len: rawBuffer.length,
        });
        return res
          .status(400)
          .json(alexaResponse({ text: "Não foi possível validar a requisição." }));
      }
      try {
        await verifyAlexaSignature({ certUrl, signature: sig, rawString });
      } catch (e) {
        console.error("[verify] failed: invalid signature", {
          msg: e?.message,
          len: rawBuffer.length,
        });
        return res
          .status(400)
          .json(alexaResponse({ text: "Não foi possível validar a requisição." }));
      }
    } else {
      console.log("[verify] bypass", {
        hasSig: !!sig,
        hasCert: !!certUrl,
        verify: false,
        len: rawBuffer.length,
      });
    }

    // 3) Agora sim, parse do JSON
    let alexaReq;
    try {
      alexaReq = JSON.parse(rawString);
    } catch (e) {
      console.error("JSON parse error:", e?.message);
      return res
        .status(400)
        .json(alexaResponse({ text: "Requisição inválida." }));
    }

    const type = alexaReq.request?.type;
    const intent = alexaReq.request?.intent?.name;
    const query = alexaReq.request?.intent?.slots?.query?.value || "";

    // 4) Fluxo de intents
    if (type === "LaunchRequest") {
      return res.status(200).json(
        alexaResponse({
          text: "Oi! O que você quer saber?",
          end: false,
        })
      );
    }

    if (type === "IntentRequest" && intent === "AskPerplexityIntent") {
      if (!MAKE_WEBHOOK_URL) {
        console.warn("MAKE_WEBHOOK_URL ausente");
        return res
          .status(200)
          .json(alexaResponse({ text: "Desculpe, estou sem conexão no momento." }));
      }

      try {
        const r = await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });

        if (!r.ok) {
          console.error("Webhook HTTP error:", r.status);
          return res
            .status(200)
            .json(alexaResponse({ text: "Desculpe, não encontrei a resposta." }));
        }

        const alexaJson = await r.json();
        return res.status(200).json(alexaJson);
      } catch (e) {
        console.error("Erro ao chamar webhook:", e?.message);
        return res
          .status(200)
          .json(alexaResponse({ text: "Desculpe, ocorreu um erro ao processar." }));
      }
    }

    // 5) Fallback
    return res
      .status(200)
      .json(alexaResponse({ text: "Desculpe, não entendi." }));
  } catch (e) {
    console.error("Erro inesperado no handler:", e);
    return res
      .status(500)
      .json(alexaResponse({ text: "Desculpe, houve um erro ao processar." }));
  }
}

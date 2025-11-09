// api/alexa.js
// Arquivo final para produção (Vercel + Alexa HTTPS endpoint)

import verifier from "alexa-verifier";

// ===== Config via Variáveis de Ambiente =====
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || ""; // opcional
const ALEXA_VERIFY = (process.env.ALEXA_VERIFY || "true").toLowerCase() === "true"; // true = exige assinatura (dispositivo físico)
const ALEXA_DEBUG = (process.env.ALEXA_DEBUG || "false").toLowerCase() === "true"; // true = mais logs de diagnóstico (opcional)

// ===== Helpers =====
function log(...args) {
  if (ALEXA_DEBUG) console.log("[ALEXA]", ...args);
}

// Lê o corpo cru da requisição (necessário para verificação de assinatura)
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Envia a pergunta para seu webhook (opcional)
async function sendToMake(query) {
  if (!MAKE_WEBHOOK_URL) return null;
  const r = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`MAKE webhook HTTP ${r.status}`);
  return r.json(); // esperamos que retorne um JSON já no formato Alexa
}

// Respostas auxiliares
function responseSSML(ssml, { end = true } = {}) {
  return {
    version: "1.0",
    response: {
      shouldEndSession: end,
      outputSpeech: { type: "SSML", ssml },
    },
  };
}

function responseText(text, { end = true } = {}) {
  return {
    version: "1.0",
    response: {
      shouldEndSession: end,
      outputSpeech: { type: "PlainText", text },
    },
  };
}

function welcome() {
  return {
    version: "1.0",
    response: {
      shouldEndSession: false,
      outputSpeech: { type: "SSML", ssml: "<speak>Oi! O que você quer saber?</speak>" },
      reprompt: { outputSpeech: { type: "PlainText", text: "Pode perguntar." } },
    },
  };
}

// ===== Handler =====
export default async function handler(req, res) {
  // Saúde / debug opcional — se preferir, deixe 405 para GET
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // 1) Pegar o corpo cru ANTES de qualquer parse
    const rawBody = await getRawBody(req);

    // 2) Verificação de Assinatura (obrigatória se ALEXA_VERIFY=true)
    if (ALEXA_VERIFY) {
      // Node normaliza para minúsculo
      const signature = req.headers["signature"];
      const certUrl = req.headers["signaturecertchainurl"];
      log("verifyOn:", ALEXA_VERIFY, "hasSig:", !!signature, "hasCert:", !!certUrl);

      if (!signature || !certUrl) {
        // Isso sempre acontece no simulador do Developer Console
        return res.status(200).json(
          responseSSML("<speak>Não foi possível validar a requisição.</speak>", { end: true })
        );
      }

      // A biblioteca espera o corpo em string (utf8)
      await verifier(certUrl, signature, rawBody.toString("utf8"));
    } else {
      log("ALEXA_VERIFY=false (modo desenvolvimento/simulador).");
    }

    // 3) Agora sim, parse do JSON
    const alexaReq = JSON.parse(rawBody.toString("utf8"));
    const type = alexaReq.request?.type;
    const intent = alexaReq.request?.intent?.name;

    // Slot principal (tentamos 'query' ou o slot padrão AMAZON.SearchQuery)
    const query =
      alexaReq.request?.intent?.slots?.query?.value ||
      alexaReq.request?.intent?.slots?.SearchQuery?.value ||
      "";

    log("type:", type, "intent:", intent, "query:", query);

    // 4) Launch
    if (type === "LaunchRequest") {
      return res.status(200).json(welcome());
    }

    // 5) Intent principal para perguntas
    if (type === "IntentRequest" && intent === "AskPerplexityIntent") {
      try {
        // Se houver webhook, tentamos usá-lo e aceitar um JSON no formato Alexa
        if (MAKE_WEBHOOK_URL) {
          const alexaJson = await sendToMake(query);

          // Se já vier no formato Alexa, devolvemos
          if (alexaJson?.response?.outputSpeech) {
            return res.status(200).json(alexaJson);
          }

          // Caso retorne algo simples, tentamos extrair texto
          const text =
            alexaJson?.response?.outputSpeech?.text ||
            alexaJson?.response?.outputSpeech?.ssml ||
            "Aqui está a resposta, mas não no formato esperado.";
          return res.status(200).json(responseText(String(text), { end: false }));
        }

        // Sem webhook: responda algo simples (place-holder local)
        if (!query) {
          return res
            .status(200)
            .json(responseSSML("<speak>Você pode me perguntar algo como: qual é a capital de Pernambuco?</speak>", { end: false }));
        }

        // Exemplo de resposta local simples:
        if (query.toLowerCase().includes("capital de pernambuco")) {
          return res.status(200).json(responseText("A capital de Pernambuco é Recife.", { end: false }));
        }

        // Fallback local
        return res
          .status(200)
          .json(responseSSML("<speak>Desculpe, ainda não sei responder isso.</speak>", { end: false }));
      } catch (err) {
        log("Erro ao consultar webhook:", err?.message || err);
        return res.status(200).json(
          responseSSML("<speak>Desculpe, houve um erro ao processar.</speak>", { end: true })
        );
      }
    }

    // 6) Fallback para qualquer outra coisa
    return res.status(200).json(responseText("Desculpe, não entendi.", { end: true }));
  } catch (err) {
    console.error("Erro no handler:", err);
    return res.status(200).json(
      responseSSML("<speak>Desculpe, houve um erro ao processar.</speak>", { end: true })
    );
  }
}

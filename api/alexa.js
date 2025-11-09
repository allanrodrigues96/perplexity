import verifier from "alexa-verifier";

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
// Somente valida se a env estiver exatamente "true"
const VERIFY = (process.env.ALEXA_VERIFY || "").toLowerCase() === "true";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const rawBody = await getRawBody(req);

    // Headers SEMPRE em minúsculas no Node
    const signature = req.headers["signature"];
    const certUrl = req.headers["signaturecertchainurl"];

    // Validação de assinatura só quando habilitada
    if (VERIFY) {
      if (!certUrl || !signature) {
        console.error("missing certificate url/signature");
        return res.status(400).send("missing certificate url/signature");
      }
      await verifyAlexaRequest(certUrl, signature, rawBody);
    }

    // Parse do JSON bruto (preferível para verificação)
    let alexaReq;
    try {
      alexaReq = JSON.parse(rawBody.toString("utf8"));
    } catch {
      // fallback: caso algum middleware já tenha parseado
      alexaReq = req.body || {};
    }

    const type = alexaReq?.request?.type;
    const intent = alexaReq?.request?.intent?.name;
    const query = alexaReq?.request?.intent?.slots?.query?.value || "";

    // LaunchRequest → mensagem de boas-vindas
    if (type === "LaunchRequest") {
      return res.status(200).json({
        version: "1.0",
        response: {
          shouldEndSession: false,
          outputSpeech: {
            type: "SSML",
            ssml: "<speak>Oi! O que você quer saber?</speak>",
          },
          reprompt: {
            outputSpeech: { type: "PlainText", text: "Pode perguntar." },
          },
        },
      });
    }

    // Intent principal → chama o Make
    if (type === "IntentRequest" && intent === "AskPerplexityIntent") {
      if (!MAKE_WEBHOOK_URL) {
        console.error("MAKE_WEBHOOK_URL ausente");
        return res.status(500).json({
          version: "1.0",
          response: {
            shouldEndSession: true,
            outputSpeech: {
              type: "PlainText",
              text: "Erro de configuração do serviço.",
            },
          },
        });
      }

      const payload = { query };
      const r = await fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // Espera que o Make devolva um JSON já no formato da Alexa
      const alexaJson = await r.json();
      return res.status(200).json(alexaJson);
    }

    // Fallback: intenção desconhecida
    return res.status(200).json({
      version: "1.0",
      response: {
        shouldEndSession: true,
        outputSpeech: { type: "PlainText", text: "Desculpe, não entendi." },
      },
    });
  } catch (err) {
    console.error("Erro no handler:", err);
    return res.status(400).json({
      version: "1.0",
      response: {
        shouldEndSession: true,
        outputSpeech: { type: "PlainText", text: "Requisição inválida." },
      },
    });
  }
}

// --- helpers ---

function getRawBody(req) {
  // Se já veio como objeto (algum parser do runtime), reconstroi o raw
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyAlexaRequest(certUrl, signature, rawBody) {
  // alexa-verifier é callback-based
  return new Promise((resolve, reject) => {
    try {
      verifier(certUrl, signature, rawBody, (err) =>
        err ? reject(err) : resolve()
      );
    } catch (e) {
      reject(e);
    }
  });
}

import verifier from 'alexa-verifier';

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // lê o corpo bruto p/ verificar assinatura
  const rawBody = await getRawBody(req);
  const signature = req.headers['signature'];
  const certUrl = req.headers['signaturecertchainurl'];

  try {
    // 1) valida assinatura/timestamp da Alexa
    await verifier(certUrl, signature, rawBody);

    // 2) parse do JSON da Alexa
    const alexaReq = JSON.parse(rawBody.toString('utf8'));
    const type = alexaReq.request?.type;
    const intent = alexaReq.request?.intent?.name;
    const query = alexaReq.request?.intent?.slots?.query?.value || '';

    // 3) LaunchRequest (skill aberta)
    if (type === 'LaunchRequest') {
      return res.json({
        version: '1.0',
        response: {
          shouldEndSession: false,
          outputSpeech: { type: 'SSML', ssml: '<speak>Oi! O que você quer saber?</speak>' },
          reprompt: { outputSpeech: { type: 'PlainText', text: 'Pode perguntar.' } }
        }
      });
    }

    // 4) Intent principal → chama Make
    if (type === 'IntentRequest' && intent === 'AskPerplexityIntent') {
      const payload = {
        query,
        userId: alexaReq.session?.user?.userId,
        locale: alexaReq.request?.locale
      };

      const r = await fetch(MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // o Make já retorna o JSON-format Alexa
      const alexaJson = await r.json();
      return res.status(200).json(alexaJson);
    }

    // 5) fallback
    return res.json({
      version: '1.0',
      response: {
        shouldEndSession: true,
        outputSpeech: { type: 'PlainText', text: 'Desculpe, não entendi.' }
      }
    });
  } catch (err) {
    console.error('Erro no proxy:', err);
    return res.status(400).json({
      version: '1.0',
      response: {
        shouldEndSession: true,
        outputSpeech: { type: 'PlainText', text: 'Requisição inválida.' }
      }
    });
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

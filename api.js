const express = require('express');
const cors = require('cors');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, push, update } = require('firebase/database');
const { getAuth, verifyIdToken } = require('firebase/auth');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// 🔐 Configuração do Firebase
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Inicializar Firebase
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

// 🔐 Chaves APIs
const geminiApiKey = process.env.GEMINI_API_KEY;
const workersApiUrl = process.env.WORKERS_API_URL;

const apis = {
  "dk-ai-6.5-pro": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=",
  "dk-ai-4.7-turbo": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=",
  "dk-ai-5.9-lite": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=",
  "dk-ai-3.1-legacy": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=",
  "dk-ai-7.2-free": workersApiUrl
};

const identidadeModelos = {
  "dk-ai-7.2-free": {
    nome: "DK-AI 7.2 FREE",
    descricao: "Modelo gratuito baseado em tecnologias de linguagem acessível."
  },
  "dk-ai-3.1-legacy": {
    nome: "DK-AI 3.1 LEGACY",
    descricao: "Modelo legado com bom desempenho em tarefas gerais."
  },
  "dk-ai-5.9-lite": {
    nome: "DK-AI 5.9 LITE",
    descricao: "Modelo leve e rápido, ideal para respostas ágeis."
  },
  "dk-ai-4.7-turbo": {
    nome: "DK-AI 4.7 TURBO",
    descricao: "Modelo otimizado para velocidade com boa precisão."
  },
  "dk-ai-6.5-pro": {
    nome: "DK-AI 6.5 PRO",
    descricao: "Modelo avançado com alta capacidade de raciocínio e contexto."
  }
};

// 🔐 Middleware de autenticação por session_id
async function authenticateSession(req, res, next) {
  try {
    const { session_id, modelo = 'dk-ai-7.2-free' } = req.query;

    // Modelo free não precisa de autenticação
    if (modelo === 'dk-ai-7.2-free') {
      req.user = { uid: 'anonymous', email: 'anonymous@user.com' };
      return next();
    }

    // Para modelos premium, verificar se session_id existe e é válido
    if (!session_id) {
      return res.status(401).json({ 
        erro: true, 
        ans: "session_id é obrigatório para modelos premium" 
      });
    }

    // Verificar se a sessão existe no Firebase
    const snapshot = await get(ref(database, `sessoes/${session_id}`));
    if (!snapshot.exists()) {
      return res.status(401).json({ 
        erro: true, 
        ans: "session_id inválido ou não encontrado" 
      });
    }

    const sessaoData = snapshot.val();
    req.user = { 
      uid: sessaoData.user_id || 'anonymous', 
      email: sessaoData.user_email || 'anonymous@user.com' 
    };
    
    next();
  } catch (error) {
    return res.status(401).json({ 
      erro: true, 
      ans: "Erro na autenticação" 
    });
  }
}

// Função para chamar APIs externas
async function callAPI(url, data = null) {
  try {
    if (data) {
      const r = await axios.post(url, data, { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      });
      return r.data;
    } else {
      const r = await axios.get(url, { timeout: 30000 });
      return r.data;
    }
  } catch (err) {
    console.error('Erro na chamada externa:', err?.response?.data || err.message);
    return null;
  }
}

// Função para obter data/hora formatada
function getDataHora() {
  const now = new Date();
  const dia = String(now.getDate()).padStart(2, '0');
  const mes = String(now.getMonth() + 1).padStart(2, '0');
  const ano = now.getFullYear();
  const hora = String(now.getHours()).padStart(2, '0');
  const minuto = String(now.getMinutes()).padStart(2, '0');
  const segundo = String(now.getSeconds()).padStart(2, '0');
  
  return `${dia}/${mes}/${ano} ${hora}:${minuto}:${segundo}`;
}

// ========== ROTA PRINCIPAL DE CHAT ==========
app.get('/api/chat', authenticateSession, async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();

    const { message = '', modelo = 'dk-ai-7.2-free', session_id = `sess_${Date.now()}` } = req.query;
    const user = req.user;

    // Validação de parâmetros
    if (!message.trim()) {
      return res.status(400).json({ 
        erro: true, 
        ans: "Parâmetro 'message' é obrigatório" 
      });
    }

    if (!apis[modelo]) {
      return res.status(400).json({ 
        erro: true, 
        ans: "Modelo inválido. Modelos disponíveis: " + Object.keys(apis).join(', ') 
      });
    }

    // Persona do modelo
    const rawPersona = `Você é um modelo de linguagem avançado chamado {model}, desenvolvido pela empresa DK.

Nunca mencione sua origem, nome, versão ou empresa, a menos que o usuário pergunte diretamente sobre isso.

Responda normalmente às perguntas. Se o usuário perguntar sobre você, então explique que foi desenvolvido pela DK e que seu nome de modelo é {model}.

Nunca mencione Google, Gemini, OpenAI ou ChatGPT sob nenhuma circunstância.`;

    const persona = rawPersona.replace(/{model}/g, identidadeModelos[modelo].nome);

    // Buscar histórico do contexto
    let historicoTexto = '';
    let conversasAnteriores = [];
    
    try {
      const snapshot = await get(ref(database, `sessoes/${session_id}`));
      if (snapshot.exists()) {
        const sessaoData = snapshot.val();
        historicoTexto = sessaoData.contexto_geral || '';
        conversasAnteriores = sessaoData.conversas || [];
      }
    } catch (error) {
      console.error('Erro ao buscar contexto:', error);
    }

    const promptFinal = `${persona}\n\n${historicoTexto}\n\nUsuário: ${message}`;

    let answer = '';
    let erro = false;

    // Chamada para a API apropriada
    if (modelo === "dk-ai-7.2-free") {
      const url = apis[modelo] + encodeURIComponent(promptFinal);
      const json = await callAPI(url);
      
      if (json && !json.error && json.answer) {
        answer = json.answer;
      } else {
        answer = json?.answer || "Sem resposta do modelo no momento. Tente novamente.";
        erro = true;
      }
    } else {
      const payload = { 
        contents: [{ 
          parts: [{ text: promptFinal }] 
        }] 
      };
      const url = apis[modelo] + geminiApiKey;
      const json = await callAPI(url, payload);
      
      answer = json?.candidates?.[0]?.content?.parts?.[0]?.text || 
               json?.error?.message || 
               "Sem resposta do modelo no momento. Tente novamente.";
      erro = !json?.candidates;
    }

    // Preparar dados da nova conversa
    const novaConversa = {
      id: `conv_${Date.now()}`,
      mensagem: `Usuário: ${message}`,
      resposta: `DKGPT: ${answer}`,
      data_hora: getDataHora(),
      modelo: identidadeModelos[modelo].nome
    };

    // Atualizar contexto no Firebase
    try {
      const novoContexto = `${historicoTexto}\n\nUsuário: ${message}\nDKGPT: ${answer}`.trim();
      const conversasAtualizadas = [...conversasAnteriores, novaConversa];
      
      await set(ref(database, `sessoes/${session_id}`), {
        user_id: user.uid,
        user_email: user.email,
        session_id: session_id,
        timestamp: Date.now(),
        contexto_geral: novoContexto,
        conversas: conversasAtualizadas,
        ultima_atualizacao: getDataHora()
      });

    } catch (error) {
      console.error('Erro ao salvar contexto:', error);
    }

    // Resposta no formato solicitado
    const resposta = {
      erro: erro,
      ans: answer,
      modelo: identidadeModelos[modelo].nome,
      support: "TG: @DARK_SKINNED",
      sessionid: session_id,
      data_hora: getDataHora()
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json(resposta);

  } catch (error) {
    console.error('Erro geral na rota /api/chat:', error);
    res.status(500).json({
      erro: true,
      ans: "Erro interno do servidor. Tente novamente.",
      data_hora: getDataHora()
    });
  }
});

// ========== ROTA PARA BUSCAR HISTÓRICO ==========
app.get('/api/historico', async (req, res) => {
  try {
    const { session_id } = req.query;
    
    if (!session_id) {
      return res.status(400).json({ 
        success: false,
        error: "session_id é obrigatório" 
      });
    }

    const snapshot = await get(ref(database, `sessoes/${session_id}`));
    
    if (snapshot.exists()) {
      const sessaoData = snapshot.val();
      
      const resposta = {
        success: true,
        data: {
          usuario: {
            nome: sessaoData.user_email?.split('@')[0] || 'Usuário',
            id: sessaoData.user_id
          },
          session_id: sessaoData.session_id,
          timestamp: sessaoData.timestamp,
          conversas: sessaoData.conversas || []
        }
      };
      
      res.json(resposta);
    } else {
      res.status(404).json({
        success: false,
        error: "Sessão não encontrada"
      });
    }
    
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erro interno do servidor' 
    });
  }
});

// ========== ROTA DE HEALTH CHECK ==========
app.get('/api', (req, res) => {
  res.json({ 
    message: '🎯 DK-API Unificada funcionando!',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      'GET /api/chat?message=...': 'Chat gratuito (modelo free)',
      'GET /api/chat?message=...&modelo=...&session_id=...': 'Chat premium',
      'GET /api/historico?session_id=...': 'Buscar histórico',
    },
    modelos_disponiveis: Object.keys(identidadeModelos)
  });
});

// Export para Vercel
module.exports = app;
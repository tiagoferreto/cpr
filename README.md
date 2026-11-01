# Pulso — treinamento de compressões torácicas

Protótipo educacional que usa o acelerômetro do celular para dar feedback
audiovisual de ritmo (alvo 100–120/min) e uma estimativa experimental de
profundidade (alvo 4,5–6,5 cm) durante o treino de RCP em adultos.

**Acesse:** https://tiagoferreto.github.io/cpr/

> Não substitui treinamento certificado. Em uma emergência real, ligue 192.

## Desenvolvimento

Requer Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

O sensor de movimento só funciona em contexto seguro (HTTPS ou `localhost`) e em
um dispositivo com acelerômetro. Para testar no celular, use o site publicado ou
exponha o servidor de desenvolvimento por HTTPS.

## Comandos

- `npm run dev`: servidor de desenvolvimento (Vite)
- `npm run build`: checagem de tipos e build estático em `dist/`
- `npm run preview`: serve o build localmente em `/cpr/`
- `npm run lint`: ESLint
- `npm test`: testes do processamento de sinal (`src/signal.test.ts`)

## Publicação

Cada push em `main` executa `.github/workflows/deploy.yml`, que gera o build e
publica no GitHub Pages. O `base` do Vite está em `/cpr/` (`vite.config.ts`).

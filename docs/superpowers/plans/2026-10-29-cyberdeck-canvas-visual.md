# Cyberdeck Canvas Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar aos cartões reais de agentes o visual cyberdeck aprovado, usando o logo do usuário e preservando o terminal funcional.

**Architecture:** `AgentCanvas.tsx` continua montando e controlando os nós; `style.css` define a nova moldura, estados e cores. O logo entra como asset estático no renderer e substitui o texto da marca na barra superior de `App.tsx`. O aprendizado acompanha as mudanças em passos pequenos.

**Tech Stack:** React, TypeScript, CSS, Electron renderer, xterm.js.

**Spec:** `docs/superpowers/specs/2026-10-29-cyberdeck-canvas-visual-design.md`

## Global Constraints

- Preservar seleção, arraste, redimensionamento, conexão, exclusão e entrada no terminal.
- Os nós têm tamanho persistido, padrão 700 × 560 px; o estilo deve funcionar até o mínimo de 220 × 300 px permitido pelo redimensionamento.
- Não alterar Electron main, IPC, MCP ou persistência.
- Não adicionar caracteres japoneses decorativos, indicador de RAM/modelo ou animação nesta etapa.
- Usar a paleta aprovada: base `#090b13`/`#0d1120`, ciano `#51e7f2`, vermelho `#ec6555`.

## Review Focus

- Nó no tamanho mínimo 220 × 300: terminal e controles continuam acessíveis, sem sobreposição que impeça o uso.
- Nó selecionado versus não selecionado: distinção visual clara sem brilho que reduza a leitura do terminal.
- Arrastar pelo cabeçalho: a nova moldura não captura o ponteiro nem bloqueia os botões.
- Redimensionar: xterm se reajusta e o controle de resize continua alcançável.
- Logo na barra estreita: não corta o menu, nome do projeto nem ações em janelas menores.

## Arquivos e responsabilidades

- Create `apps/desktop/src/renderer/src/assets/mikoshi-logo.png`: asset fornecido pelo usuário.
- Modify `apps/desktop/src/renderer/src/App.tsx`: exibir o logo na barra superior.
- Modify `apps/desktop/src/renderer/src/AgentCanvas.tsx`: estrutura mínima de classes/elementos necessária para a moldura recortada, sem modificar eventos.
- Modify `apps/desktop/src/renderer/src/style.css`: tokens, canvas, cartões, terminal e responsividade.

### Task 1: Marca na barra superior

- [x] Copiar o logo fornecido para `src/renderer/src/assets/mikoshi-logo.png` e referenciá-lo em `App.tsx` com texto alternativo `Mikoshi AI Orchestrator`.
- [x] Ajustar `.app-topbar` no CSS para exibir o logo sem cortar o nome do projeto; em largura menor, reduzir a marca sem esconder o botão do menu.
- [ ] Abrir a aplicação e conferir a barra superior em duas larguras de janela.

### Task 2: Moldura cyberdeck dos nós

- [x] Ajustar apenas a estrutura necessária em `AgentCanvas.tsx` para ter contorno recortado e superfície interna, mantendo `article`, `header`, `AgentTerminal` e handlers existentes.
- [x] Aplicar em `style.css` fundo quase preto, contorno ciano fino, canto angular e destaque luminoso ao `.canvas-node.selected`.
- [x] Estilizar cabeçalho, metadados e botões com hierarquia clara; o terminal mantém o maior espaço do cartão.
- [ ] Verificar no app um nó normal e um selecionado, primeiro no tamanho padrão e depois em 220 × 300 px.

### Task 3: Canvas e integração

- [x] Aplicar a paleta ao fundo do canvas e às conexões SVG, mantendo contraste e legibilidade dos terminais.
- [ ] Confirmar manualmente seleção, arraste, resize, conexão, exclusão e digitação no terminal.
- [x] Rodar `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build` e verificar formatação dos arquivos alterados; corrigir falhas causadas pela mudança. O `format:check` global segue falhando por CRLF preexistente em 39 arquivos.
- [x] Revisar o diff e registrar limitações visuais observadas. A revisão independente encontrou um contorno cortado, corrigido com superfície interna separada; validação visual no Electron ainda pendente neste ambiente.

## Self-review

- O plano cobre logo, cartões, canvas, estados e verificação do terminal previstos na spec.
- Nenhuma etapa cria dados fictícios de modelo ou RAM no produto.
- Os controles existentes permanecem nas mesmas responsabilidades; só apresentação e estrutura interna mínima mudam.
- Testes novos de CSS não agregariam verificação significativa; a checagem visual e a suíte existente cobrem o risco deste recorte.

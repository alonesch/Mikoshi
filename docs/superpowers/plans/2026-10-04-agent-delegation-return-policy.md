# Delegação de agentes e política de retorno — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Permitir que qualquer provider usado como Orchestrator delegue trabalho a agentes conectados no canvas, usando seus terminais interativos visíveis e escolhendo explicitamente se o resultado volta.

**Architecture:** O processo principal hospeda um servidor MCP Streamable HTTP em loopback, autentica cada sessão por token e aplica as permissões do workspace antes de injetar tarefas nos PTYs ativos. Configurações MCP efêmeras por provider apontam para esse servidor sem editar autenticação/configuração global. A Mikoshi registra handoffs e resultados sem ler ou interpretar o scrollback da TUI, e encerra sessões e processos descendentes iniciados por ela.

**Tech Stack:** Electron main/preload, TypeScript, Node.js, `node-pty`, MCP SDK compatível com Node 24, testes `node:test`. Fixar versões explícitas; não usar `latest`.

**Spec:** `docs/superpowers/specs/2026-10-04-agent-delegation-return-policy-design.md`

## Global Constraints

- Qualquer provider configurado pode ser o Orchestrator; o papel do agente determina as permissões.
- A conexão do canvas é uma permissão direcional; só destinos conectados por uma seta de saída podem receber delegações.
- Cada delegação exige escolha explícita entre `somente na tela` e `retornar resultado ao Orchestrator`.
- O worker executa no próprio terminal visível; não há execução headless nem leitura do scrollback para inferir conclusão.
- Não editar configuração global nem credenciais dos providers.
- IPC usa prefixo `mikoshi:`; React não acessa Node/Electron diretamente.
- Manter `contextIsolation: true`, `nodeIntegration: false` e sandbox habilitado.
- Usar TypeScript/TSX, 2 espaços, aspas duplas, semicolons e trailing comma em estruturas multilinha; evitar `any`.
- Não encerrar processos que a Mikoshi não iniciou.

## Review Focus

- Um token inválido, expirado ou de outra sessão não pode listar agentes, delegar ou devolver resultado; testar autenticação e isolamento de projeto/sessão no Task 2.
- Um Orchestrator sem seta de saída ou com destino inativo não pode causar escrita no PTY; testar os dois casos no Task 2.
- Uma chamada concorrente não pode duplicar o terminal do mesmo agente; testar com resolução do executável bloqueada no Task 1.
- Texto de tarefa ou retorno grande/malformado não pode exceder limites nem entrar como comando MCP; testar limites no Tasks 2 e 4.
- Encerrar um PTY antes do retorno solicitado deve falhar a espera sem capturar a tela ou afetar processos externos; testar no Tasks 5 e 6.

## Arquivos e responsabilidades

- Modify `apps/desktop/src/contracts.ts`: tipos compartilhados para política de retorno, sessões MCP e ferramentas de delegação.
- Create `apps/desktop/src/main/services/agent-bridge.ts`: transporte loopback local, tokens por sessão, validação de workspace/agente/conexão, despacho e espera por retorno.
- No helper MCP child process: the MCP server runs inside the existing Electron main process, avoiding a second runtime executable.
- Create `apps/desktop/src/main/services/provider-mcp.ts`: argumentos e arquivos temporários de configuração MCP por provider; gerenciamento da entrada Mikoshi no arquivo Antigravity do workspace sem apagar entradas alheias.
- Modify `apps/desktop/src/main/services/terminal-manager.ts`: serialização de start, emissão de tokens/configuração por papel, injeção de handoff no PTY e limpeza de helpers/configuração associada.
- Modify `apps/desktop/src/main/ipc.ts`: registrar bridge e handoffs, validar chamadas existentes e encaminhar eventos de estado ao renderer.
- Modify `apps/desktop/src/main/services/store.ts`: persistir estados de handoff (`pending`, `started`, `completed`, `failed`) e resultado explícito quando solicitado.
- Modify `apps/desktop/src/main/index.ts`: assegurar encerramento idempotente dos recursos locais na saída da aplicação.
- Os argumentos MCP são montados em `provider-mcp.ts`; adapters de execução estruturada permanecem inalterados.
- Modify `apps/desktop/package.json` and `package-lock.json`: adicionar MCP SDK em versão fixa e scripts/checks somente se necessários ao helper.
- Create `apps/desktop/tests/agent-bridge.test.ts`: autenticação, permissões, retorno e falhas da ponte.
- Create `apps/desktop/tests/provider-mcp.test.ts`: arquivos/argumentos por provider e preservação da configuração Antigravity.
- Modify `apps/desktop/tests/terminal-manager.test.ts`: concorrência de start, entrega com Enter e encerramento sem atingir processos externos.
- Modify `apps/desktop/tests/orchestrator.test.ts` or create `apps/desktop/tests/terminal-handoff.test.ts`: persistência e transições do handoff.

### Task 1: Serializar a abertura de terminais

**Files:** `apps/desktop/src/main/services/terminal-manager.ts`, `apps/desktop/tests/terminal-manager.test.ts`.

**Interfaces:** manter `start(projectId: string, agentId: string, cols?: number, rows?: number): Promise<AgentTerminalSession>`; proteger cada par projeto/agente desde antes de `resolveExecutable` até que a sessão esteja registrada ou o start falhe.

- [x] Escrever teste com duas chamadas simultâneas enquanto `resolveExecutable` está aguardando; verificar que só um PTY é criado e a outra chamada recebe erro de terminal existente/inicializando.
- [x] Executar `npm test --workspace=@mikoshi/desktop`; confirmar que o novo teste falha antes da alteração.
- [x] Implementar reserva/liberação por agente em `try/finally`, cobrindo falha de resolução e de `spawnPty`.
- [x] Executar `npm test --workspace=@mikoshi/desktop` e confirmar todos os testes de terminal.

### Task 2: Implementar ponte autenticada e ferramentas de delegação

**Files:** `apps/desktop/src/contracts.ts`, `apps/desktop/src/main/services/agent-bridge.ts`, `apps/desktop/tests/agent-bridge.test.ts`, `apps/desktop/package.json`, `package-lock.json`.

**Interfaces:** `AgentBridge.listen(): Promise<void>` inicia o servidor local; `AgentBridge.openSession(projectId: string, terminalId: string, agentId: string): Promise<AgentBridgeSession>` cria contexto/token da sessão; `AgentBridge.listTargets(session: McpSession): Promise<ConnectedAgent[]>`; `AgentBridge.delegate(session: McpSession, input: DelegateAgentInput): Promise<DelegateReceipt | AgentResult>`; `AgentBridge.receiveResult(session: McpSession, handoffId: string, result: string): Promise<void>`; `AgentBridge.shutdown(): Promise<void>`. `McpSession` contém `id`, `projectId`, `agentId`, `role` e token aleatório; `ConnectedAgent` contém id/nome/provider/papel; `DelegateAgentInput` contém `targetAgentId`, `task` e `returnPolicy: "screen-only" | "return-to-orchestrator"`; `AgentResult` contém `handoffId` e `result`. Helpers MCP chamam somente essas operações.

- [x] Escrever testes para listar somente conexões de saída do agente Orchestrator e rejeitar worker como origem, token inválido, conexão ausente, destino inativo e destino de outro projeto.
- [x] Escrever testes de política: `screen-only` retorna recibo após injetar a tarefa; `return-to-orchestrator` aguarda `receiveResult` e entrega apenas o texto final informado pelo worker.
- [x] Executar `npm test --workspace=@mikoshi/desktop`; confirmar que os novos testes falham.
- [x] Adicionar `@modelcontextprotocol/sdk@1.32.0` como dependência runtime fixa e implementar um servidor Streamable HTTP no main, ligado somente a `127.0.0.1`, com um servidor/transporte MCP por sessão e schemas estritos; não expor filesystem, shell ou execução de comandos.
- [x] Implementar autenticação bearer com token aleatório por sessão, invalidação no encerramento, validação de projeto/papel/conexão e respostas de erro limitadas.
- [x] Executar `npm test --workspace=@mikoshi/desktop` e confirmar autenticação, isolamento e as duas políticas de retorno.

### Task 3: Configurar MCP por sessão para cada provider

**Files:** `apps/desktop/src/main/services/provider-mcp.ts`, `apps/desktop/src/main/services/provider-adapters.ts`, `apps/desktop/tests/provider-mcp.test.ts`, `apps/desktop/package.json` apenas se o helper precisar de script de build dedicado.

**Interfaces:** `configureProviderMcp(provider: ProviderId, projectRoot: string, terminalId: string, session: ProviderMcpSession): Promise<ProviderMcpConfiguration>` retorna argumentos interativos, variáveis/arquivo temporário e função `cleanup(): Promise<void>`; a rotina recebe providerId e papel do agente, sem pressupor Codex como Orchestrator.

- [x] Escrever testes para geração de configuração de Codex, Claude, Antigravity e Kimi; verificar que cada uma aponta ao endpoint HTTP do main e fornece bearer token, mas não credenciais globais.
- [x] Escrever testes de Antigravity com configuração preexistente: adicionar/atualizar somente o bloco `mikoshi`, preservar campos de terceiros e remover somente esse bloco no dispose.
- [x] Executar `npm test --workspace=@mikoshi/desktop`; confirmar falha dos casos novos.
- [x] Implementar launch/configuração conforme os argumentos MCP aceitos por cada CLI instalada; manter arquivos temporários com permissões restritas e limpeza idempotente. Codex recebe MCP via overrides `-c`; Claude recebe JSON inline em `--mcp-config`; Kimi usa `.kimi-code/mcp.json`; Antigravity usa `.agents/mcp_config.json`. Kimi/Antigravity removem a entrada temporária no fechamento.
- [x] Executar testes, `npm run typecheck --workspace=@mikoshi/desktop` e `npm run build --workspace=@mikoshi/desktop`.

### Task 4: Conectar a sessão MCP ao terminal visível

**Files:** `apps/desktop/src/main/services/terminal-manager.ts`, `apps/desktop/src/main/services/provider-adapters.ts`, `apps/desktop/tests/terminal-manager.test.ts`.

**Interfaces:** `AgentTerminalManager.start(...)` continua retornando `AgentTerminalSession`; adicionar dependências explícitas para criar sessão MCP e configuração de provider. `prepareHandoff(projectId: string, fromAgentId: string, toAgentId: string, task: string, handoffId: string): Promise<void>` injeta contexto + instrução de tarefa no terminal alvo e envia Enter. Não altera o input digitado pelo usuário diretamente na TUI.

- [x] Escrever testes verificando que qualquer provider com role `Orchestrator` recebe ferramentas de listar/delegar, providers workers recebem somente a ferramenta de retorno e provider não determina papel.
- [x] Escrever teste verificando que o handoff termina em uma única escrita com delimitadores seguros e `\r`, e que não há headless run.
- [x] Executar testes de terminal e ponte e confirmar falha inicial.
- [x] Integrar lançamento e limpeza dos sessões/configurações; garantir que o sessão MCP acompanha a vida do terminal e que a injeção só ocorre com terminal destino ativo.
- [x] Executar `npm test --workspace=@mikoshi/desktop`, typecheck e build.

### Task 5: Persistir handoffs e entregar retorno explícito

**Files:** `apps/desktop/src/main/services/store.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/contracts.ts`, `apps/desktop/tests/terminal-handoff.test.ts` (ou `orchestrator.test.ts`).

**Interfaces:** criar handoff com `status: "pending"`, registrar `started` após injeção, `completed` após retorno solicitado ou recibo para `screen-only`, e `failed` em falha; `result?: string` só é preenchido por `receiveResult`. Renderer recebe eventos `mikoshi:agent-handoff-event` com o handoff atualizado. Cancelamento por encerramento do destino rejeita a espera ativa com erro identificado ao handoff.

- [x] Escrever testes de transições e persistência em disco para as duas políticas, rejeição de retorno fora da sessão/destino e worker encerrado antes de retornar.
- [x] Executar testes de store/bridge para confirmar falha inicial.
- [x] Implementar validação de IPC e integração store/bridge em `registerIpc`; erros de rota, sessão ou estado devem ser legíveis e não disparar provider headless.
- [x] Executar `npm test --workspace=@mikoshi/desktop` e typecheck.

### Task 6: Encerrar recursos da Mikoshi com segurança

**Files:** `apps/desktop/src/main/services/terminal-manager.ts`, `apps/desktop/src/main/services/provider-mcp.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/tests/terminal-manager.test.ts`.

**Interfaces:** `shutdown(): Promise<void>` em bridge, terminal manager e provider config cleanup; repetidas chamadas são seguras. A saída encerra apenas PTYs e helpers registrados nesta instância e remove apenas configuração temporária/bloco Mikoshi.

- [x] Escrever testes de shutdown repetido, PTY finalizado antes do shutdown, sessão MCP encerrada e configuração restaurada sem alteração de conteúdo alheio.
- [x] Executar testes de terminal/config para confirmar falha inicial.
- [x] Implementar encerramento idempotente e aguardar limpeza antes de concluir `before-quit`, mantendo sandbox e isolamento.
- [x] Executar `npm test --workspace=@mikoshi/desktop`, `npm run typecheck --workspace=@mikoshi/desktop` e `npm run build --workspace=@mikoshi/desktop`.

### Task 7: Verificação integrada com providers e documentação operacional

**Files:** `apps/desktop/tests/terminal-handoff.test.ts`, `README.md` se necessário para explicar descoberta/ativação das ferramentas; demais arquivos somente para corrigir falhas achadas nos testes integrados.

- [x] Adicionar teste integrado com provider A como Orchestrator e provider B como destino, depois repetir com outro provider A; confirmar que papel e aresta, não o nome do provider, autorizam a delegação.
- [x] Verificar os caminhos `screen-only`, `return-to-orchestrator`, sem instrução explícita, destino não conectado, destino inativo e encerramento antes do retorno.
- [x] Executar `npm test`, `npm run typecheck`, `npm run build` e `npm run format:check` na raiz.
- [x] Fazer revisão final do diff para confirmar que renderer não acessa Node/Electron, não existem modelos forçados, arquivos globais de autenticação permanecem intocados e subprocessos não pertencentes à Mikoshi não são encerrados.

---

## Self-review

- Spec coverage: provider-neutral Orchestrator and directed canvas permission (Tasks 2, 4, 7); explicit return behavior and worker-authored result (Tasks 2, 5, 7); provider-scoped MCP setup and Antigravity preservation (Task 3); no headless execution or terminal scraping (Tasks 2, 4, 5); duplicate start and bounded input (Tasks 1, 2, 4); safe shutdown and process ownership (Task 6); visible handoff state (Task 5).
- Placeholder scan: no TBD/TODO steps; each implementation task has named files, interfaces, tests, and commands.
- Type consistency: session/delegation types are declared in Task 2 and consumed by Tasks 3–6; handoff id and return result flow are declared in Task 5 and used by Tasks 2 and 4.
- Review focus tests are assigned to their owning tasks (1, 2, 4, 5, 6).

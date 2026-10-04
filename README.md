# Mikoshi

Mikoshi é um aplicativo desktop local para manter memória revisável por projeto e coordenar agentes que usam CLIs já instaladas pelo usuário. O renderer cuida da interface; filesystem, processos, autenticação por CLI e IPC ficam no processo main.

## Requisitos e comandos

Use Node.js 24 e npm. Na raiz do repositório:

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run format:check
npm run build
npm run dist:win
```

`npm run preview` abre o build local. O instalador Windows sem assinatura é criado em `apps/desktop/release/Mikoshi-Setup-0.0.1.exe`; a versão extraída fica em `apps/desktop/release/win-unpacked/Mikoshi.exe`. O desinstalador preserva os dados do usuário. A assinatura de executável, Microsoft Store e atualização automática não fazem parte do escopo.

## Fluxo local

Selecione uma pasta para registrar o projeto. A Mikoshi cria `.mikoshi/project.json` com um UUID portátil; seus dados de memória ficam em `app.getPath("userData")`, em `%APPDATA%/Mikoshi` no Windows. Use **Bootstrap para revisão** para extrair candidatos de documentação e manifestos permitidos. Revise e aprove as mudanças antes de torná-las memória canônica.

O registro de providers começa vazio em cada perfil. Em **Configurações**, verifique Codex, Claude Code, Antigravity ou Kimi; quando uma CLI for encontrada, a Mikoshi registra o executável apenas nesta máquina. Agentes só podem usar providers registrados.

Antes de executar uma tarefa, escolha um papel ou agente configurado, descreva o trabalho, selecione `read-only` ou `workspace-write` e prepare o contexto. A Mikoshi seleciona memórias ativas relevantes, mostra o texto preparado e inicia a CLI correspondente. Respostas estruturadas podem sugerir mudanças de memória; elas ficam em revisão até aprovação ou rejeição. Execuções não são repetidas automaticamente depois de um encerramento.

O canvas cria um terminal por vez pela barra superior, usando um provider verificado em Configurações e o papel escolhido para aquele agente. Orchestrator e Worker são conectados automaticamente quando coexistem no mesmo workspace. Cada cartão abre a CLI interativa real em um PTY na raiz do projeto; entrada e saída ficam visíveis no próprio canvas. O controle de tarefa prepara o prompt com instruções do agente e memória relevante; a delegação entre agentes cola o contexto no terminal destino e envia Enter para iniciar o trabalho. Os terminais são locais e não são exportados no Engram. A execução estruturada permanece disponível para tarefas que geram diffs de memória revisáveis.

Session Context é temporário e pertence a uma execução da CLI. Project Memory é a memória canônica persistida pelo projeto, sempre alterada por diffs revisados. Orchestration State guarda configuração de agentes, tarefa/estado operacional, runs e handoffs; ele não vira memória semântica. Working Context é montado pela Mikoshi para cada tarefa, combinando instruções do agente, papel, tarefa, workflow, handoff e as memórias ativas mais relevantes.

## Security model

O app exige CLIs oficiais e suas autenticações locais. Não lê arquivos de token nem pede API keys à parte. O status relata versão e instalação; quando a CLI permite, verifica autenticação local. Providers que só validam acesso na primeira chamada aparecem como pendentes, sem a Mikoshi afirmar que estão autenticados.

`read-only` é o padrão. `workspace-write` usa o modo restrito disponibilizado pelo provider; não há bypass de permissão nem desativação de sandbox do Electron. Cancelar encerra o processo local, mas não desfaz gravações já realizadas pela CLI. Um limite de tempo encerra execuções demoradas.

O bootstrap percorre allowlists determinísticas de README, AGENTS, documentos de arquitetura/decisões/tarefas/problemas, Markdown em `docs/` e manifestos/configurações conhecidos. Ignora arquivos sensíveis, pastas de saída, symlinks e documentos fora dos limites de profundidade/tamanho/quantidade. Também registra estrutura, branch e até três títulos de commits recentes. Bullets candidatos recebem evidência observada, explícita, inferida, convenção, tarefa, problema ou instrução; o heurístico não substitui a revisão humana. Segredos detectáveis são redigidos antes do envio ou exportação; candidatos de entropia são sinalizados. O scanner pode ter falso positivo ou não reconhecer um segredo, por isso a revisão do usuário continua necessária. A Mikoshi não controla arquivos que a CLI provider decida ler internamente.

O renderer não usa Node ou Electron diretamente. O preload publica uma API mínima com `contextBridge`; IPC é validado e usa canais `mikoshi:`. `contextIsolation`, sandbox e `nodeIntegration: false` ficam habilitados. Não são aceitas navegações externas, janelas inesperadas ou origem/frame de renderer inválido.

## Estrutura principal do monorepo

```text
apps/desktop/src/main/       filesystem, processos, store, providers, IPC
apps/desktop/src/preload/    API mínima exposta ao renderer
apps/desktop/src/renderer/   React UI e estilos
apps/desktop/src/contracts.ts contratos compartilhados tipados
apps/desktop/tests/          testes de serviços e smoke Electron real
docs/superpowers/plans/      plano da implementação local
```

## Memória e Engram

A memória canônica é `projects/<id>/memory.json` (schema v2), com itens `active`, `obsolete` ou `removed`, classificação de evidência, proveniência e histórico limitado. ADD, UPDATE, REMOVE, MARK_OBSOLETE e RESTORE deixam eventos auditáveis. Remoção lógica mantém histórico; diffs com revisão base obsoleta são recusados. O limite local é 1000 itens, 1000 origens por item e 1000 eventos de histórico.

O Engram v2 é um JSON de transporte manual para continuar o mesmo projeto em outra máquina. Inclui memória, proveniência, histórico, agentes, contexto de tarefa e handoffs; remove raízes locais e segredos. Não transporta sessões vivas da CLI, processos em execução ou IDs de runs locais. O projeto mantém um ID estável em `.mikoshi/project.json`; na máquina de destino, selecione a mesma pasta/clonagem e importe o Engram. O import aceita o Engram v1 legado, exige identidade de projeto correspondente e apresenta estratégia **Mesclar** ou **Substituir**. Substituir propõe tornar obsoletos os itens locais ausentes; não apaga memória. Conflitos e mudanças de memória, agentes e handoffs precisam ser revistos na interface. Configurações não selecionadas permanecem intactas. Um handoff importado fornece tarefa e resumo como contexto para iniciar uma nova execução local.

O workspace de agentes é um canvas espacial local ao projeto/máquina: crie terminais pela barra do canvas, mova e redimensione os cartões, use pan/zoom e desenhe conexões de saída. Quando um terminal tem o papel **Orchestrator**, sua própria CLI recebe ferramentas MCP da Mikoshi para listar agentes ativos conectados e delegar uma tarefa diretamente ao terminal visível do destino. Isso funciona com qualquer provider no papel de Orchestrator. A CLI do worker executa a tarefa em sua tela; a Mikoshi não lê o scrollback. Ao delegar, o Orchestrator escolhe explicitamente se o resultado deve ficar somente no terminal do worker ou retornar como resultado de ferramenta ao próprio Orchestrator. Se a intenção estiver ambígua, ele deve perguntar antes de delegar. Conexões de saída limitam destinos, e a regra é validada no processo main. As sessões MCP usam um servidor HTTP local em loopback e credenciais por terminal: bearer token nas CLIs que aceitam variável de ambiente e URL aleatória de capacidade no Antigravity, que não oferece interpolação de variável em headers MCP HTTP. Configurações específicas de cada CLI são removidas quando o terminal fecha. Layout e cabos não viajam no Engram; os agentes aprovados podem ser importados em outra máquina.

O mapa Windows/Linux é salvo apenas nos dados locais da Mikoshi. O preview verifica roots absolutos e existentes e apresenta quantas referências conhecidas podem ser remapeadas. Paths internos podem virar `<PROJECT_ROOT>/...`; caminhos externos não são remapeados. A validação impede escapes para fora da raiz mapeada.

## Armazenamento local

O store usa JSON para dados pequenos e locais: projeto por app profile, app com instância única, limite de 1000 memórias e escrita por arquivo temporário seguida de rename. Esse desenho mantém inspeção/migração simples e evita uma dependência estrutural de banco. Cada arquivo tem substituição atômica; várias gravações de arquivos distintos não formam uma transação de banco. Projetos ficam protegidos por fila serial no processo main, e operações interrompidas são detectadas na próxima inicialização. Se o produto avançar para sincronização ou concorrência entre processos/máquinas, o store deve migrar para SQLite/transações antes dessa etapa.

Arquivos por projeto no `userData` incluem `memory.json`, `draft-<id>.json`, `runs.json`, `orchestration-state.json`, `path-mappings.json` e `REVIEW.md`. O arquivo de revisão é um relatório humano, não uma segunda memória canônica. No projeto, `.mikoshi/project.json` contém apenas formato e ID estável.

## Providers e limites do produto

Codex CLI, Claude Code CLI, Google Antigravity CLI (`agy`) e Kimi Code (`kimi`) têm adapters próprios para descoberta, comandos, formatos de resposta e permissões. A Mikoshi procura os executáveis no `PATH` e em diretórios de instalação do usuário derivados de `%LOCALAPPDATA%` e `%USERPROFILE%`; nenhum caminho de uma máquina específica fica gravado no código. Cada agente mantém seu provider configurado.

Codex e Claude Code recebem seus modos de planejamento/somente leitura; o Antigravity usa `--mode=plan`, que investiga com ferramentas somente leitura e pede aprovação antes de escrever. A CLI Kimi 2.1.1 testada oferece prompt não interativo por argumento, mas não combina esse modo com `--plan` e executa chamadas de ferramentas sob a política `auto`; por isso, a Mikoshi bloqueia execuções Kimi em `read-only` e exige que o usuário selecione `workspace-write`. A autenticação e o acesso à assinatura Kimi só podem ser confirmados pela primeira chamada real; a CLI pode estar autenticada e ainda responder que a assinatura não inclui Kimi Code. A Mikoshi não instala CLIs nem lê arquivos de credenciais.

Esta entrega é local e single-user. Cloud, login próprio, OAuth, workers remotos, sincronização automática, billing, colaboração multiusuário, restauração de sessões de terminal após reiniciar, vector database, importação de sessões passadas, instalação Store e assinatura são etapas futuras.

## Padrões

TypeScript/TSX usa dois espaços, aspas duplas, semicolons e trailing commas em estruturas multilinha, verificados com Prettier. Serviços de negócio ficam em `apps/desktop/src/main/services`; `src/preload` contém somente exposição mínima do contrato e `src/renderer` contém UI. Canais IPC usam o prefixo `mikoshi:`. Dependências Electron/Vite/builder são fixadas sem alias `latest`.

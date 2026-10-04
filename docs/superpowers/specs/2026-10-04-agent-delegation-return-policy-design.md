# Mikoshi — delegação de agentes e política de retorno

## Problema

As conexões do canvas persistem e desenham uma seta entre agentes, mas a sessão
interativa do Orchestrator não recebe uma ferramenta para usar essa rota. Por
isso, ele pode dizer que vai chamar o Reviewer enquanto o terminal do Antigravity
continua parado. Embora o aplicativo já chame os métodos de encerramento ao
fechar, ainda falta garantir e testar que os processos descendentes dos
terminais também terminem. Starts concorrentes podem abrir mais de uma sessão
para o mesmo agente.

## Objetivo e decisões

- Qualquer provider configurado pode ser o Orchestrator. O papel do agente no
  workspace, e não o provider usado no terminal, determina as permissões de
  orquestração.
- A conexão do canvas é uma permissão direcional: o Orchestrator só pode
  delegar para destinos conectados por uma seta de saída.
- Cada delegação escolhe explicitamente se o resultado volta ao Orchestrator.
  Essa decisão vem da instrução do usuário e é enviada pelo Orchestrator junto
  com a tarefa; não é inferida automaticamente pelo papel, provider ou tipo de
  tarefa.
- Antigravity, Kimi ou outro provider executa a tarefa no próprio terminal
  visível do canvas. O usuário acompanha a saída diretamente ali.
- Não há execução headless para o worker e não se altera configuração global
  dos providers.
- Sem retorno solicitado, o usuário acompanha o resultado no terminal do
  worker e pode continuar a conversa ali ou enviar um novo prompt ao
  Orchestrator.
- Com retorno solicitado, o worker envia seu resultado final explícito ao
  Orchestrator; só esse caso transfere conteúdo de volta e consome tokens
  adicionais no Orchestrator.
- Exemplos: uma tree pode ficar só na tela do worker, enquanto um resultado de
  testes pode voltar ao Orchestrator. São exemplos de uso, não regras associadas
  às palavras “tree”, “teste”, aos papéis Reviewer/Tester ou a um provider.
- A Mikoshi encerra somente processos que iniciou e impede starts duplicados do
  mesmo agente.

## Fluxo proposto

1. O usuário conecta o Orchestrator a um ou mais agentes no canvas e inicia os
   terminais que pretende usar.
2. O terminal interativo do agente com papel Orchestrator recebe ferramentas
   MCP locais da Mikoshi: listar agentes conectados e delegar uma tarefa com
   uma opção obrigatória de retorno (`somente na tela` ou `retornar resultado
   ao Orchestrator`).
3. O Orchestrator segue a instrução explícita do usuário sobre retorno. Se ela não
   estiver clara, pergunta antes de delegar; a Mikoshi não escolhe um padrão
   silencioso nem infere a escolha pelo tipo de tarefa ou agente.
4. Ao delegar, o provider configurado como Orchestrator chama a ferramenta de
   listagem se precisar identificar o destino e chama a ferramenta de delegação
   com destino, tarefa e opção de retorno.
5. A Mikoshi valida a sessão de origem, a identidade do Orchestrator, a conexão
   direcional e a sessão ativa do destino. Se o terminal do destino não estiver
   ativo, a chamada falha com instrução para iniciá-lo no canvas; não se abre
   uma execução headless ou oculta.
6. A Mikoshi prepara o contexto canônico relevante para o projeto e o papel do
   destino, insere a tarefa no terminal interativo do destino e envia Enter.
7. Em `somente na tela`, a ferramenta retorna apenas um recibo curto de envio e
   o worker mostra o resultado somente em seu terminal. A Mikoshi não envia a
   resposta do worker ao Orchestrator.
8. Em `retornar resultado ao Orchestrator`, o worker recebe a instrução para
   chamar uma ferramenta MCP de retorno ao terminar. A chamada de delegação aguarda
   esse retorno e entrega ao Orchestrator o resultado final explícito do worker.
   Ela não captura nem interpreta o buffer visual do terminal.
9. O canvas registra o handoff: screen-only passa para concluído após a tarefa
   ser submetida ao PTY; retorno solicitado passa para concluído quando o worker
   envia seu resultado. O encerramento antes disso marca falha, sem analisar a
   saída ou estados visuais da TUI.

## Fronteiras técnicas

- O agente Orchestrator recebe ferramentas para listar conexões e delegar,
  qualquer que seja seu provider. Terminais de agentes que podem ser destinos
  recebem a ferramenta de retorno do resultado, necessária somente quando a
  delegação pedir retorno.
- A configuração MCP é escopada à invocação da CLI sempre que ela permitir,
  sem editar arquivos globais de configuração ou autenticação. O
  Antigravity só documenta configuração global ou `.agents/mcp_config.json` no
  workspace; nesse caso, a Mikoshi mantém uma entrada identificada como sua,
  preserva as demais e remove somente sua entrada ao encerrar o terminal.
- Codex recebe overrides MCP por argumentos de invocação; Claude Code recebe
  uma definição JSON inline em `--mcp-config`, com bearer token referenciado
  pelo ambiente; Kimi recebe uma entrada temporária em
  `.kimi-code/mcp.json`; Antigravity recebe uma entrada temporária em
  `.agents/mcp_config.json`. As entradas de projeto de Kimi/Antigravity são
  removidas ao encerrar o terminal, e as demais entradas são preservadas.
- A ponte entre o processo MCP e o processo principal da Mikoshi fica limitada
  ao loopback local, usa credencial por sessão e valida projeto/agente/conexão
  antes de encaminhar qualquer tarefa.
- A ponte não expõe ferramentas de filesystem, shell ou execução de comandos;
  suas operações limitam-se a listar destinos conectados, inserir uma tarefa
  em um terminal ativo permitido e, quando solicitado, receber um resultado
  final do agente de destino.
- O servidor MCP roda dentro do processo main e não inicia um processo auxiliar.
  O encerramento da aplicação fecha os terminais que ela iniciou, invalida as
  sessões MCP e remove as entradas temporárias de provider. A CLI pode ter
  serviços próprios fora do PTY; a Mikoshi não encerra processos que não iniciou.
- Ao encerrar a janela ou a aplicação, a Mikoshi termina a árvore de processos
  de cada terminal PTY e encerra seus serviços locais. Starts simultâneos do
  mesmo agente são serializados antes de resolver o executável e criar o PTY.
- Processos do Codex Desktop, seus MCPs e outros processos que a Mikoshi não
  iniciou permanecem sob controle do Codex Desktop e não são encerrados pela
  Mikoshi.
- A Mikoshi não força modelos dos providers; usa as escolhas compatíveis com a
  conta e a configuração do usuário. O erro de modelo do Codex mostrado na
  captura é um problema independente da delegação.

## Falhas e comportamento visível

- Sem conexão direcional: o Orchestrator recebe um erro curto indicando que o
  destino não está conectado.
- Terminal do destino ausente ou encerrado: o Orchestrator recebe uma orientação
  para iniciar o terminal do agente no canvas.
- Destino ocupado ou inicializando: a tarefa não é duplicada; a ferramenta
  retorna o estado correspondente para o Orchestrator informar ao usuário.
- Retorno solicitado, mas o worker encerra sem chamar a ferramenta de retorno:
  a delegação termina com estado de falha de retorno. O trabalho e a saída
  continuam visíveis no terminal do worker; o Orchestrator recebe apenas o
  estado da falha, sem captura do buffer.
- Ponte local indisponível: a ferramenta falha sem tentar executar o worker em
  modo headless.
- Encerrar um terminal ou a Mikoshi: a sessão e seus processos filhos
  associados são encerrados, sem tocar nos processos pertencentes ao Codex
  Desktop.

## Critérios de aceite

1. Com uma seta entre um agente Codex no papel Orchestrator e um Reviewer
   Antigravity, e ambos os terminais ativos, o Orchestrator usa a ferramenta
   Mikoshi e o Reviewer recebe a tarefa com Enter no terminal visível. Repetir
   o mesmo teste com outro provider configurado como Orchestrator também deve
   funcionar.
2. Com `somente na tela`, a ferramenta retorna apenas recibo de entrega; o
   resultado completo permanece no terminal do Reviewer e não chega ao
   Orchestrator.
3. Com `retornar resultado ao Orchestrator`, o Reviewer chama a ferramenta de
   retorno; o Orchestrator recebe o resultado final que o Reviewer escreveu e
   pode apresentá-lo ao usuário.
4. Sem uma instrução explícita sobre retorno, o Orchestrator pergunta ao usuário
   antes de delegar.
5. Uma rota inválida ou um terminal de destino inativo gera erro explícito e
   nenhuma execução alternativa oculta.
6. Parar um terminal ou fechar a Mikoshi invalida a sessão MCP, remove a
   configuração temporária e encerra o PTY que a Mikoshi iniciou.
7. Dois pedidos concorrentes para iniciar o mesmo agente criam no máximo uma
   sessão PTY.
8. A configuração global e as credenciais dos providers permanecem intocadas;
   cada CLI continua usando o modelo selecionado/configurado pelo usuário.

## Riscos e limites

- A decisão do provider usado como Orchestrator de chamar a ferramenta depende
  de reconhecer a delegação na solicitação do usuário; o prompt e a descrição
  da ferramenta devem deixar claro que agentes conectados são destinos reais de
  trabalho.
- O terminal interativo não fornece um protocolo comum para detectar o fim da
  resposta entre providers. Não se deve inferir conclusão parseando texto livre
  ou estados visuais frágeis da TUI.
- O modo de retorno depende de o worker usar a ferramenta MCP de retorno. Essa
  resposta é texto final fornecido pelo worker, não uma cópia automática de todo
  o scrollback da TUI.
- Os exemplos de tree e teste ilustram os dois modos e não determinam a escolha.
  Qualquer agente e qualquer tarefa pode usar qualquer um dos modos, conforme
  instrução explícita do usuário.

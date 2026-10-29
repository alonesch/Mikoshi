# Mikoshi — visual cyberdeck do canvas

## Intenção

Usar a primeira evolução visual da Mikoshi como exercício prático de React e CSS. O usuário quer aprender a localizar, escrever e verificar as mudanças no código. A referência escolhida é a lista de quickhacks do Cyberpunk 2077 fornecida pelo usuário: contorno ciano luminoso, recortes angulares, fundo quase preto e destaque claro para o item selecionado. O logo fornecido pelo usuário entra na barra superior.

## Escopo deste primeiro treinamento

- Aplicar a linguagem do mockup v4 aos cartões de agentes e ao fundo do canvas, com o terminal como área principal de cada cartão.
- Ajustar o cabeçalho do cartão, estado selecionado, metadados, botões e conexões para a nova paleta, mantendo leitura e foco visível.
- Usar o logo fornecido, sem caracteres japoneses adicionais ou ícones decorativos que sugiram santuário.
- Preservar a navegação e os fluxos reais existentes; alterações de estrutura ficam restritas ao que a estilização dos cartões exigir.
- Ensinar cada mudança na ordem da trilha `.teach/syllabus.md`, com edição e verificação em etapas pequenas.

## Fora do escopo

- Figma, modelagem visual e animação.
- Copiar assets ou telas do jogo além da referência de forma, cor e hierarquia.
- Indicador de consumo de “RAM”/tokens, força, capacidade ou identificação do modelo. Essa ideia fica registrada para uma evolução futura, quando houver definição da fonte e do significado dos dados.
- Mudanças de execução de agentes, MCP, persistência ou segurança do Electron.

## Abordagens consideradas

1. Sala de controle com muitos painéis: mostra estado em detalhe, mas o usuário considerou a tela carregada e genérica.
2. Santuário digital com torii e caracteres japoneses: tem identidade forte, mas se afasta do universo de Cyberpunk 2077 que o usuário quer para a Mikoshi.
3. HUD com cartões inspirados no cyberdeck: selecionada. Mantém o canvas como foco, esconde informação secundária e usa a moldura ciano do quickhack para destacar os agentes.

## Direção visual aprovada na prévia

- Base escura azulada (`#090b13` e `#0d1120`), ciano (`#51e7f2`) para contornos e seleção, vermelho (`#ec6555`) para ação pontual.
- Cartões com recorte angular, borda fina, fundo interno escuro e brilho mais forte apenas no selecionado. O terminal ocupa a maior parte da altura.
- Logo existente na barra superior; outras áreas permanecem discretas para não competir com os terminais.
- Informações adicionais podem ser recolhidas em iteração posterior; este recorte implementa primeiro o canvas e os cartões.

## Restrições do código atual

- `App.tsx` monta o `AgentCanvas`; `AgentCanvas.tsx` monta cada `.canvas-node` e inclui `AgentTerminal`; `style.css` concentra os estilos.
- Os nós usam largura e altura persistidas, com padrão de 700 × 560 px e redimensionamento. A moldura precisa funcionar em qualquer tamanho permitido, sem cortar controles ou o terminal.
- `AgentTerminal` usa xterm e `ResizeObserver` para ajustar linhas e colunas. Estilo novo não pode impedir seu redimensionamento nem capturar entrada de teclado.
- Seleção, arraste, redimensionamento, conexão e exclusão precisam continuar operando.

## Verificação

- Conferir visualmente um cartão normal e um selecionado, em tamanhos padrão e reduzidos, com terminal aberto.
- Confirmar que controles, foco, arraste, redimensionamento e conexões seguem visíveis e utilizáveis.
- Rodar typecheck, testes relevantes e build após a implementação.

## Referência visual

- Mockup descartável local: `F:\Repos\Mikoshi\.superpowers\brainstorm\mikoshi-preview-v4.html`.
- Imagem do cyberdeck e logo anexados pelo usuário nesta conversa.

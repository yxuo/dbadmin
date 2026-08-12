# DBAdmin — PostgreSQL com UI moderna no VS Code

DBAdmin entrega uma experiência de banco de dados **enxuta, visual e poderosa** dentro do VS Code.  
Conecte, explore, filtre, consulte e opere no PostgreSQL sem sair do editor.

## Por que DBAdmin

- **Interface moderna e direta**: foco no que importa, sem poluição visual.
- **Fluxo rápido**: ações comuns acessíveis em poucos cliques.
- **Poder para uso real**: leitura de dados, metadados, exportação, backup e restore.

## Recursos principais

- **Explorador de banco em árvore**: conexões → databases → schemas → tabelas.
- **Gerenciamento de conexões**: criação, edição e remoção com persistência global.
- **Visualização de tabelas**: paginação, filtros avançados e navegação fluida.
- **Metadados completos**: colunas, índices e constraints com leitura clara.
- **Exportação de dados**: formatos CSV e JSON.
- **SQL Book**: execução interativa de consultas com resultado em grade.
- **Backup e restore**: integração com `pg_dump` e `pg_restore`.

## Preview da interface

Use esta seção para mostrar o visual real da extensão na loja.

![Sidebar com árvore de conexões e ações rápidas](docs/assets/preview-sidebar-tree.png)
_Placeholder: mostrar a sidebar com conexão expandida, botão de filtro e ações de contexto._

![Tabela com paginação e filtros avançados](docs/assets/preview-table-data.png)
_Placeholder: mostrar grid de dados com filtro aplicado, ordenação e paginação._

![Painel de metadados da tabela](docs/assets/preview-metadata.png)
_Placeholder: mostrar colunas, tipos, índices e constraints em layout limpo._

![Fluxo de backup e restore](docs/assets/preview-backup-restore.png)
_Placeholder: mostrar telas de backup/restore destacando simplicidade do fluxo._

## Guia de screenshots recomendado

Para comunicar valor rapidamente na página da loja:

1. **Visão geral da sidebar**
2. **Tabela com filtro avançado**
3. **Metadados de tabela**
4. **Backup/restore em ação**
5. **SQL Book com resultado**

Dicas rápidas para capturas:

- Use dados de exemplo limpos e legíveis.
- Evite informações sensíveis (host, usuário, dados reais).
- Prefira zoom legível e recortes que destaquem a ação principal.
- Mantenha consistência visual entre as imagens.

## Instalação

1. Abra o Marketplace no VS Code.
2. Procure por **DBAdmin**.
3. Clique em **Install**.

Alternativa via VSIX:

1. Baixe o `.vsix` da release.
2. Execute **Extensions: Install from VSIX...**.

## Requisitos

- VS Code 1.85+
- Acesso a servidor PostgreSQL
- `pg_dump` e `pg_restore` para recursos de backup (opcional)

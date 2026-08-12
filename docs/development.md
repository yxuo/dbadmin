# Desenvolvimento

Este guia reúne instruções voltadas para desenvolvimento local, build, empacotamento, validação de conteúdo do pacote e publicação.

## 1) Pré-requisitos

- Node.js e npm instalados
- Dependências do projeto instaladas
- Conta com acesso ao publisher no Visual Studio Marketplace (para publicação)
- PAT criado no Azure DevOps (para publicação)

## 2) Instalar dependências

```bash
npm install
```

## 3) Compilar a extensão

```bash
npm run compile
```

## 4) Empacotar VSIX

Comando padrão:

```bash
npx @vscode/vsce package --no-dependencies --out <nome-do-pacote>.vsix
```

## 5) Instalar VSIX localmente

Via CLI:

```bash
code --install-extension .\<nome-do-pacote>.vsix --force
```

Via interface:

1. Abra Extensions no VS Code.
2. Clique em `...`.
3. Selecione `Install from VSIX...`.
4. Escolha o arquivo VSIX gerado.

## 6) Verificar o que vai para o pacote

Para listar arquivos incluídos no VSIX:

```bash
npx @vscode/vsce ls
```

Se necessário, ajuste o arquivo `.vscodeignore` para remover artefatos de desenvolvimento, arquivos temporários e conteúdos locais.

## 7) Publicação no Marketplace

### 7.1 Criar PAT (Azure DevOps)

1. Acesse `https://aex.dev.azure.com/me`.
2. Abra `Personal access tokens`.
3. Crie um token com:
   - Scope: `Custom defined`
   - Marketplace: `Manage` (e `Publish` se o painel separar permissões)
4. Não usar `Full access`.

### 7.2 Login com vsce

```bash
npx @vscode/vsce login <publisher-id>
```

### 7.3 Publicar

```bash
npx @vscode/vsce publish
```

ou:

```bash
npx @vscode/vsce publish <versao>
```

## 8) Checklist de release

- Build concluído sem erros.
- VSIX gerado com sucesso.
- Conteúdo do pacote revisado (`vsce ls`).
- `README.md` atualizado para página da loja.
- `CHANGELOG.md` atualizado com a versão.
- `LICENSE` presente.

## 8.1) Configuração de conexões

- Cada conexão pode definir uma lista opcional de bancos visíveis na sidebar.
- Quando a lista estiver preenchida, apenas esses bancos serão exibidos no explorador.
- Quando a lista estiver vazia, todos os bancos disponíveis para a conexão serão exibidos.

## 9) Segurança e operação

- Use PAT com escopo mínimo.
- Defina expiração curta e faça rotação periódica.
- Nunca versionar PAT no repositório.
- Em CI, usar secrets do provedor (ex.: GitHub Actions Secrets).

# Publicar no VS Code Marketplace

Este guia apresenta o fluxo de publicação no Marketplace de forma genérica.

## 1) Pré-requisitos

- Conta Microsoft com acesso ao publisher da extensão.
- PAT (Personal Access Token) criado no Azure DevOps.
- Projeto compilando e empacotando sem erros.

## 2) Criar PAT

1. Acesse `https://aex.dev.azure.com/me`.
2. Abra `Personal access tokens`.
3. Crie um novo token com:
   - Scope: `Custom defined`
   - Marketplace: `Manage` (e `Publish` se o painel separar permissões)
4. Não use `Full access`.

## 3) Login

```bash
npx @vscode/vsce login <publisher-id>
```

## 4) Publicar

```bash
npx @vscode/vsce publish
```

ou:

```bash
npx @vscode/vsce publish <versao>
```

## 5) Boas práticas

- Usar PAT com escopo mínimo.
- Definir expiração curta e rotacionar periodicamente.
- Em CI, salvar o PAT em secrets.
- Nunca versionar PAT no repositório.

## 6) Guia completo para dev

Para fluxo completo de desenvolvimento (build, VSIX, validação do pacote e release), consulte:

- [docs/development.md](docs/development.md)

# Publicar no Visual Studio Marketplace

Este guia mostra como publicar a extensão na loja oficial do VS Code.

## Checklist de publicação

Antes de publicar, garanta:

- `publisher` em `package.json` aponta para seu publisher real (não `local`)
- versão (`version`) atualizada em `package.json`
- build passando (`npm run compile`)
- arquivo de licença presente (`LICENSE`, `LICENSE.md` ou `LICENSE.txt`)
- campo `repository` definido em `package.json`
- `activationEvents` revisado (evitar `*` para melhor performance e revisão)
- `.vscodeignore` revisado para não empacotar arquivos desnecessários

## 1) Criar publisher no Marketplace

1. Entre em: https://marketplace.visualstudio.com/manage
2. Crie um publisher (se ainda não existir).
3. Anote o ID do publisher.

## 2) Criar Personal Access Token (PAT)

1. Acesse: https://dev.azure.com
2. Crie um PAT com escopo para Marketplace (manage/publish).
3. Guarde o token em local seguro.

## 3) Ajustar manifesto

No `package.json`:

- `publisher`: seu publisher
- `version`: próxima versão semântica
- `repository`: URL do repositório

Exemplo:

```json
{
  "publisher": "seu-publisher",
  "version": "0.0.2",
  "repository": {
    "type": "git",
    "url": "https://github.com/yxuo/database-vscode"
  }
}
```

## 4) Login no vsce

```bash
npx @vscode/vsce login seu-publisher
```

Quando solicitado, cole o PAT.

## 5) Publicar

Publicação direta:

```bash
npx @vscode/vsce publish
```

Ou publicando com incremento automático:

```bash
npx @vscode/vsce publish patch
```

## 6) Validação pós-publicação

- Verifique a página da extensão no Marketplace
- Instale a extensão publicada em uma instância limpa do VS Code
- Valide ativação e funcionalidades principais

## Revisão específica deste projeto

Pontos que você precisa ajustar para publicar agora:

1. Trocar `publisher: local` no `package.json`.
2. Adicionar campo `repository` no `package.json`.
3. Adicionar arquivo de licença no repositório.
4. Revisar `activationEvents` para remover `*` se possível.
5. Subir versão antes do `publish`.

Sem esses ajustes, o empacotamento/publicação tende a exibir avisos e exigir confirmações interativas.

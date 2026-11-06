# Third-party notices

SelfSend does not include any vendored, copied or forked third-party source code, fonts,
icons, images or data.

## npm dependencies

The packages listed in `package.json` (Hono, `@hono/node-server`, zod, Nodemailer, the AWS SDK
for JavaScript v3 clients for SES and SNS, and for development TypeScript, `@types/*` and the
`resend` SDK) are installed from npm by `npm install` / `npm ci` and are not part of this
repository. Each is used under its own licence (MIT, MIT-0 or Apache-2.0; see each package's
`LICENSE` file in `node_modules`).

If you build the Docker image, it contains the production dependencies in `node_modules`,
each with its own licence file. If you distribute that image, keep those files with it.

The Docker Compose setup pulls the `node` and `caddy` container images at build and deploy
time. They are not included in this repository and are used under their own licences.

## Resend API and the `resend` SDK

SelfSend implements a subset of the public Resend REST API so that the official `resend`
Node.js SDK can talk to it. The endpoint paths, JSON field names, error names (`src/errors.ts`)
and webhook header names follow what the published `resend@6.34.1` package sends and expects.
That shape was worked out by reading the package, and the end-to-end tests call SelfSend with
it. No SDK source code is included in this repository.

- Project: https://github.com/resend/resend-node
- Used in: `src/api/`, `src/errors.ts`, `src/models.ts` (API shapes only), `test/sdk.test.ts` (as a dev dependency)

The SDK is used under its licence:

```
MIT License

Copyright (c) 2023 Plus Five Five, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Specifications

These public specifications were implemented from their documentation. No code was copied.

- Standard Webhooks signatures: https://www.standardwebhooks.com (`src/worker.ts`, `signWebhook`)
- Amazon SNS message signature verification: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html (`src/mail/ses-events.ts`)
- RFC 8058 one-click unsubscribe (`List-Unsubscribe-Post`): https://www.rfc-editor.org/rfc/rfc8058 (`src/worker.ts`, `src/public.ts`)
- RFC 9562 UUID version 7: https://www.rfc-editor.org/rfc/rfc9562 (`src/util.ts`, `uuidv7`)

## Trademarks

Resend is a trademark of its owner. Amazon Web Services, AWS, Amazon SES and Amazon SNS are
trademarks of Amazon.com, Inc. or its affiliates. SelfSend is an independent project and is not
affiliated with, endorsed by or sponsored by either company. The names are used only to describe
compatibility. No logos are used.

---
title: Webhooks & Remote Triggers
description: Configuring Deployra's built-in HTTP webhook receiver for GitHub and GitLab
order: 8
---

# Webhooks & Remote Triggers 🪝

In addition to periodic Git polling, Deployra includes a built-in, lightweight HTTP webhook receiver. This allows your Git provider to notify Deployra immediately when commits are pushed.

---

## 🌐 Webhook Configuration

Enable the webhook receiver in `deployra.config.yaml`:

```yaml
webhook:
  enabled: true
  port: 9000
  path: /webhook/deployra
  secret: ${DEPLOYRA_WEBHOOK_SECRET}
```

Start the daemon. Deployra will listen on `0.0.0.0:9000` (or configured host/port).

---

## 🐙 GitHub Integration

1. Go to your GitHub repository: **Settings > Webhooks > Add webhook**.
2. **Payload URL**: `https://deployra.your-domain.com/webhook/deployra`
3. **Content type**: `application/json`
4. **Secret**: Enter the exact secret matching `DEPLOYRA_WEBHOOK_SECRET`.
5. **Which events**: Select **Just the push event**.

### HMAC-SHA256 Verification:
Deployra automatically validates the `X-Hub-Signature-256` header:
- Computes `crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex')`.
- Compares signatures using timing-safe comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
- Automatically extracts `ref` (`refs/heads/main`) and `after` commit SHA.
- Dispatches a deployment to the Workmatic queue with trigger type `webhook`.

---

## 🦊 GitLab Integration

1. Go to your GitLab project: **Settings > Webhooks > Add new webhook**.
2. **URL**: `https://deployra.your-domain.com/webhook/deployra`
3. **Secret token**: Enter `DEPLOYRA_WEBHOOK_SECRET`.
4. **Trigger**: Check **Push events**.

### Secret Token Verification:
Deployra validates the `X-Gitlab-Token` header using timing-safe buffer comparison.

---

## ⚡ Performance & Buffer Optimization

- Deployra calculates HMAC digests directly from the incoming raw body stream into memory buffers.
- Eliminates intermediate string encodings and JSON re-serialization overhead.
- Requests with invalid signatures are rejected immediately with HTTP 401 before any disk or database operations occur.

# TODOS

Reportés lors de la revue du plan (`PLAN.md`, /plan-eng-review du 2026-10-04). Rien ici n'entre dans les 12 h du hackathon, sauf mention contraire.

## Hackathon (à trancher pendant la journée)

### Choisir entre l'app Next.js unique et la séparation `backend/` / `frontend/`

**What:** Le plan prévoit une seule app Next.js (routes API + UI), alors que le repo contient déjà `backend/` et `frontend/` (fichiers vides).

**Why:** Deux structures concurrentes, c'est du temps perdu à H0 et des conflits de chemins entre les voies A et B.

**Context:** Les deux `base.txt` sont vides, rien n'est perdu quel que soit le choix. Recommandation : une seule app Next.js à la racine, ou dans `frontend/` si l'équipe tient à la séparation, avec les routes API dedans. Un backend séparé ne se justifie que si une partie de l'équipe code en Python.

**Effort:** S
**Priority:** P0
**Depends on:** None

### Vérifier les modèles disponibles sur l'API Mistral (dont GLM)

**What:** `GET https://api.mistral.ai/v1/models`, puis remplir le tableau `MODELS` (classify / extract / draft) dans `lib/mistral.ts`.

**Why:** Le plan suppose que GLM est disponible via l'API Mistral, ce qui n'a pas été vérifié.

**Context:** Décision 7 du plan : modèles mixtes, un rapide pour la classification et un fort pour l'extraction et la rédaction.

**Effort:** S
**Priority:** P0
**Depends on:** Clé API Mistral

## Produit (après le hackathon)

### Vrais connecteurs Slack, Teams et e-mail

**What:** Remplacer le faux Slack par des intégrations réelles (Slack Events API, Microsoft Graph, réception d'e-mails entrants).

**Why:** La détection à la source est la promesse n°1 du one-pager (W1).

**Context:** Scanner les communications des salariés est en soi un traitement de données personnelles : base légale, minimisation (déclencheurs par mots-clés), transparence, AIPD, information du CSE. Voir le §8 du one-pager. À faire avant tout pilote client.

**Effort:** L
**Priority:** P1
**Depends on:** Authentification

### Authentification, permissions et RLS réelle

**What:** Comptes utilisateurs et rôles (personne qui détient les faits / décideur / coordinateur), plus des policies RLS Supabase par organisation.

**Why:** La policy de lecture anon n'est acceptable que pour la démo. L'outil contiendra les informations les plus sensibles de l'entreprise.

**Context:** Pendant la démo, l'écriture passe par la `service_role` côté serveur et la lecture se fait en anon via Realtime. Hébergement UE, chiffrement et contrôle d'accès sont exigés (§8).

**Effort:** M
**Priority:** P1
**Depends on:** None

### Limitation de débit sur les routes d'écriture

**What:** Limiter le débit de `/intake`, `/answer`, `/decide` et `/draft` (par IP ou par clé).

**Why:** R04 : la clé `DEMO_KEY` suffit pour 12 h, pas pour une URL publique durable.

**Context:** Décidé lors de l'arbitrage du 2026-10-04. Options : Vercel Firewall (règles de débit) ou Upstash Ratelimit.

**Effort:** S
**Priority:** P1
**Depends on:** Authentification

### Couche juridiction (États membres)

**What:** Un seul moteur, avec autorités, formulaires, langue et délais nationaux par pays (transposition de NIS2).

**Why:** NIS2 est une directive : les règles varient selon les transpositions nationales (la France et la Pologne ont un statut à vérifier).

**Context:** Pendant le hackathon, la France est codée en dur et la Pologne simplement mentionnée. Le plus simple : les données d'autorité et les squelettes de templates indexés par pays, sans toucher à `rules.ts`.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Transcription d'appel

**What:** Envoi ou transcription d'un appel d'incident, puis extraction des faits.

**Why:** C'est souvent par un appel au support IT que l'incident est d'abord signalé.

**Context:** Pendant le hackathon, on utilise une transcription préparée. Il faut informer l'interlocuteur, et selon la juridiction obtenir son consentement.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Seuils de l'Implementing Regulation (EU) 2024/2690 et modules DORA / CRA

**What:** Seuils de « significant incident » pour les fournisseurs d'infrastructure et de services numériques, puis modules DORA et CRA.

**Why:** Feuille de route produit du §10 : plus de régimes, plus de délais, plus de valeur.

**Context:** Ce sont des ajouts de règles dans `rules.ts` et de champs dans `facts.ts`, sans nouvelle architecture.

**Effort:** L
**Priority:** P3
**Depends on:** Couche juridiction

## Completed

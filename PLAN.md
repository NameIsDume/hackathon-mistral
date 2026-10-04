# Feuille de route : hackathon LLM x Mistral (incidents GDPR / NIS2)

Source : one-pager Notion « Hackathon LLM x Mistral ». Revue : /plan-eng-review du 2026-10-04.
Équipe : 1 développeur + 1 juriste. Durée : 12 h. Démo : 3 min, phishing dans une entreprise de cloud française (NIS2 dans le périmètre, clients en Pologne).

## Décisions figées

| # | Sujet | Décision |
|---|-------|----------|
| D2 | Stack | Next.js (App Router) + AI SDK `@ai-sdk/mistral` + shadcn/ui + Vercel |
| 1 | Moteur juridique | **Hybride** : le LLM extrait des faits typés, `rules.ts` (déterministe, écrit avec le juriste) rend le verdict, le LLM rédige |
| 2 | État | **Supabase**, 2 tables : `incidents` (horodatages + faits jsonb) et `incident_events` (ajout seul, sert de journal d'audit et de registre Art. 33(5)). Écriture côté serveur (service_role), lecture via Realtime |
| 3 | Fiabilité | Fonction unique `callMistral()` : délai max de 8 s, puis repli sur les fixtures du scénario de démo. Plus une vidéo de secours |
| 4 | Questions | Un seul schéma de faits. Questions = champs vides. Texte écrit par le juriste, destinataire défini par champ, le LLM ne fait que reformuler |
| 5 | Templates | Squelette fixe par template (juriste), champs remplis par les faits, narratif rédigé par Mistral, **champs manquants en rouge** |
| 6 | Tests | Vitest (règles, délais, repli) + 3 scénarios du juriste + évaluation de l'extraction sur les fixtures + **Playwright E2E** sur le parcours de démo |
| 7 | Modèles | **Mixtes** : tableau `MODELS` dans `lib/mistral.ts` (classify / extract / draft), fixé à H0 via `GET /v1/models` (vérifier que GLM y figure) |

## Architecture

```
 [Faux Slack]──POST /api/intake──► classify (modèle rapide)
                                     ├─ bruit ──► ignoré (affiché « pas un incident »)
                                     └─ incident ─► extractFacts (Zod Facts) + brief
                                                    │
                                     Supabase incidents.first_signal_at  + event "signal"
                                                    │
               missingFacts(facts) ──► questions (texte juriste, reformulé) ──► /answer/[id] (téléphone IT)
                                                    │  POST /api/answer → merge facts + event
                                                    ▼
                      rules.ts : gdpr33() · gdpr34() · nis2Significant()  → oui | non | indéterminé + motifs
                      clocks.ts : 24 h / 72 h / 1 mois depuis awareness_at (provisoire : first_signal_at)
                                                    │
                      Coordinateur : confirme la prise de connaissance (awareness), enregistre la décision et ses motifs (humain)
                                                    ▼
                      templates : CNIL · alerte précoce NIS2 · information des personnes · registre
                      (squelette + faits + narratif + manques en rouge)
 Dashboard DPO ◄── Supabase Realtime (incidents, incident_events)
```

**Règle anti-pire-cas (lacune critique repérée lors de la revue).** Un fait extrait par le LLM porte `source: "llm"` et reste *à confirmer*. Si un fait décisif (`encrypted`, `personalData`, `subjectsCount`, `serviceDisrupted`) n'a pas été confirmé par un humain, `rules.ts` renvoie **indéterminé**, jamais « pas besoin de notifier ». Sans cette règle, un `encrypted: true` halluciné active l'exception de l'Art. 34 sans que personne ne le voie.

## Fichiers

```
supabase/schema.sql          incidents, incident_events, policy RLS de lecture anon (démo uniquement)
lib/facts.ts                 schéma Zod Facts + métadonnées par champ (question, destinataire, décisif ?)
lib/rules.ts                 gdpr33, gdpr34, nis2Significant  (fonctions pures)
lib/clocks.ts                échéances à partir de awareness_at / first_signal_at
lib/mistral.ts               MODELS + callMistral(model, schema, prompt, fixtureKey)
lib/templates.ts             squelettes + rendu (champs manquants signalés)
app/page.tsx                 faux Slack + dashboard (brief, comptes à rebours, évaluation, brouillons)
app/answer/[id]/page.tsx     questions pour les personnes qui détiennent les faits
app/api/{intake,answer,decide,draft}/route.ts
fixtures/*.json              réponses Mistral enregistrées (scénario de démo + 3 scénarios)
tests/{rules,clocks,mistral}.test.ts, tests/extract.eval.ts, e2e/demo.spec.ts
```

## Planning heure par heure

| Heure | Développeur | Juriste | Point de contrôle |
|-------|-------------|---------|-------------------|
| 0–1 | `gh repo create`, scaffold Next + shadcn, projet Supabase + schema.sql, `vercel link`, variables d'env. `GET /v1/models` → tableau MODELS | Liste des faits nécessaires (champs) + **3 scénarios** avec verdict attendu (GDPR seul / NIS2 seul / les deux) | Repo déployé (page blanche en ligne) |
| 1–2 | `facts.ts` (à partir de la liste du juriste) + `callMistral()` (délai max + fixtures) + `/api/intake` (classify → extract → brief → insert) | Arbres oui/non : Art. 33, Art. 34 (exceptions), NIS2 Art. 23(3) | Un curl sur intake crée un incident |
| 2–3 | `rules.ts` + `clocks.ts` + Vitest des 3 scénarios | Texte de chaque question + destinataire (IT, DPO, métier) | **Tests du verdict au vert** |
| 3–5 | UI : faux Slack, carte du brief, comptes à rebours en direct, Realtime ; page `/answer/[id]` | Squelettes : notification CNIL, alerte précoce NIS2, information des personnes, entrée de registre | Parcours intake → brief → questions en ligne |
| 5–7 | Écran d'évaluation côte à côte (faits cités, article, indéterminé), confirmation de la prise de connaissance, enregistrement de la décision et de ses motifs | Formulation des motifs, notamment le cas « décision de ne pas notifier » (Art. 33(5)) | Décision enregistrée dans incident_events |
| 7–8 | Rendu des templates (narratif + manques en rouge), registre construit à partir des events, déploiement sur Vercel | Relit les brouillons générés | **Parcours complet déployé** |
| 8–9 | Enregistrement des fixtures, éval de l'extraction, Playwright `demo.spec.ts` | Teste les 3 scénarios dans l'UI | **Gel des fonctionnalités à H9** |
| 9–10 | `/qa` sur l'URL Vercel, corrections ; script de reset de la démo | Corrige les sorties fausses (règles et textes) → relance Vitest | Tout au vert |
| 10–12 | Vidéo de secours, 3 répétitions chronométrées | Pitch + réponses aux 4 questions du jury (§11) | Prêt pour la scène |

## Plan de tests

| Chemin | Test |
|--------|------|
| `rules.ts` × 3 scénarios + faits null + faits LLM non confirmés → indéterminé | Vitest (critique) |
| `clocks.ts` : prise de connaissance confirmée / provisoire, 24 h / 72 h / 1 mois, délai dépassé | Vitest |
| `callMistral` : succès / délai dépassé → fixture / erreur 429 → fixture | Vitest (fetch mocké) |
| classify : message de bruit (« nos ventes sont un désastre ») → pas un incident | Éval (fixtures) |
| extractFacts sur les 3 scénarios → champs attendus | Éval |
| Parcours de démo : Slack → brief → réponse IT → évaluation → décision → 2 brouillons + registre | Playwright E2E |

## Modes de défaillance

| Défaillance | Test | Gestion | Visible ? |
|-------------|------|---------|-----------|
| Fait décisif halluciné (chiffré) | rules.test | confirmation humaine exigée → indéterminé | oui |
| Mistral lent ou en 429 sur scène | mistral.test | repli sur fixture | invisible (voulu) |
| Realtime ne pousse rien | E2E | bouton rafraîchir + revalidation | oui |
| Message de bruit classé comme incident | éval | bouton « fausse alerte » | oui |

## Hors périmètre (reporté)

- Vrais connecteurs Slack, Teams et e-mail : faux Slack à la place (one-pager §9).
- Transcription d'appel : transcription préparée à la place.
- Authentification et permissions : la policy RLS de lecture anon est **acceptable pour la démo seulement**.
- Couche juridiction (autorités, formulaires et langue par État membre) : France codée en dur, Pologne en mention.
- DORA, CRA, seuils de l'Implementing Regulation 2024/2690 : feuille de route produit.
- TODOS.md : non créé, cette section en tient lieu pour le hackathon.

## Ce qui existe déjà

Rien côté code (repo vierge). On réutilise le one-pager (périmètre, flux, socle juridique, scénario de démo) et ses §4–5 comme spécification de `rules.ts`.

## Parallélisation

- Voie A, le cœur (`lib/` + tests) : facts → rules → clocks.
- Voie B, l'UI (`app/`) : elle démarre dès que `facts.ts` existe (H2).
- Voie C, le contenu (juriste) : en parallèle tout du long, sans conflit de fichiers (il remet des tableaux et des textes que le dev intègre).
- A et B partagent `lib/facts.ts` : il faut le figer à H2.

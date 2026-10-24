<!-- version: 2026-10-19 -->
# Confidentialité du Hub Personas

## Ce que le Hub conserve

- **Compte** : adresse e-mail, nom affiché, identifiant et pseudo GitHub si vous vous connectez par GitHub, rôle, dates de création et de dernière connexion. Pas de mot de passe : l'authentification passe par Supabase Auth (lien magique ou GitHub).
- **Jetons personnels** : nom, début du jeton, empreinte (jamais le jeton lui-même), portées, dates d'expiration et de dernière utilisation.
- **Contenus publics** : modules, packs, avis, étoiles, signalements, attribués à votre compte.
- **Télémétrie, seulement si vous l'avez acceptée dans Personas** : par étude terminée, les références des modules utilisés, le nombre de personas et quelques champs techniques courts. Le Hub ne garde qu'un agrégat quotidien par version (installations distinctes, études, personas). L'identifiant d'installation est tournant, jamais lié à votre compte, et son empreinte est effacée après 30 jours.
- **Journaux techniques** : méthode, chemin, statut et durée des requêtes, sans corps ni jeton.

## Ce que le Hub ne reçoit jamais

Vos projets, pitchs, offres, cibles, études, réponses, récits et clés API restent sur votre machine. Le Hub ne les voit pas.

## Suppression de compte

Vous pouvez supprimer votre compte en libre-service (`DELETE /v1/me`). Le Hub efface alors votre e-mail, votre nom affiché et vos identifiants GitHub, révoque vos jetons, retire vos étoiles et vos avis. **Vos versions publiées sont conservées et attribuées à « auteur supprimé »**, parce que des études y sont épinglées et doivent rester reproductibles ; votre namespace reste réservé. Pour supprimer aussi le compte de connexion (Supabase), écrivez à l'adresse ci-dessous.

## Sous-traitance et hébergement

Le Hub et son authentification (Supabase auto-hébergé) tournent sur un serveur de l'exploitant. Aucune donnée n'est vendue ni partagée à des fins publicitaires.

## Vos droits

Accès, rectification, suppression, opposition : écrivez à pierre.armanet.pa@gmail.com.

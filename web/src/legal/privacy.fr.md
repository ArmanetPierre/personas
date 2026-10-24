<!-- version: 2026-10-24 -->
# Confidentialité de Personas en ligne

Personas en ligne est la version hébergée du simulateur Personas : vous l'utilisez dans le navigateur, sans rien installer. Contrairement à l'application locale, **vos projets sont stockés sur le serveur de l'exploitant**. Cette page dit ce qui est conservé, où, et qui le reçoit.

## Ce que le service conserve

- **Compte** : adresse e-mail, identifiant de connexion, identifiant et pseudo GitHub si vous vous connectez par GitHub, dates de création et de dernière connexion. Pas de mot de passe : la connexion passe par un lien envoyé par e-mail ou par GitHub (Supabase Auth).
- **Vos contenus** : projets, pitchs, offres, cibles, études, réponses et récits des personas, modules et réglages. Ils sont stockés sur le serveur de l'exploitant, **dans une base séparée pour chaque compte**. Aucun autre utilisateur n'y a accès.
- **Votre clé IA** : **chiffrée sur le serveur**, utilisée uniquement pour vos études. Elle n'est jamais réaffichée : seuls ses 4 derniers caractères sont montrés. Le fournisseur, le modèle et vos plafonds de dépense sont conservés avec elle.
- **Journaux techniques** : méthode, chemin, statut et durée des requêtes, sans leur contenu ni votre clé, pendant une durée limitée, pour la sécurité et le diagnostic.

Vos contenus et votre clé sont conservés tant que votre compte existe, et effacés quand vous le supprimez. Votre adresse e-mail et votre identifiant de connexion restent enregistrés dans le service de connexion (Supabase Auth) après la suppression, tant que l'exploitant ne les efface pas. Après la suppression, le serveur ne garde que l'empreinte (SHA-256) de l'identifiant du compte et de son adresse e-mail, avec le jour de la suppression, sans limite de durée, pour refuser toute nouvelle connexion : une adresse supprimée ne peut plus être réutilisée sur ce service ; écrivez à l'exploitant pour la réactiver.

## Votre fournisseur d'IA reçoit les données de vos études

Quand vous lancez une étude, le serveur appelle **le fournisseur d'IA que vous avez choisi** (Anthropic, OpenAI, Google Gemini ou OpenRouter) avec votre clé. Il lui envoie ce dont l'étude a besoin : le pitch, l'offre et son prix, la description de la cible, les profils des personas et les questions.

**Ce fournisseur devient destinataire de ces données.** Il les traite selon ses propres conditions et sa propre politique de confidentialité, qui s'appliquent à votre compte chez lui. N'écrivez dans un projet rien que vous ne voulez pas lui confier, en particulier aucune donnée personnelle de tiers.

## Ce que le service ne fait pas

- Pas de cookie de suivi, pas de publicité, pas de mesure d'audience. Un seul cookie, de session, nécessaire à la connexion.
- Le thème et la langue de l'interface sont gardés dans votre navigateur, pas sur le serveur.
- Aucune donnée n'est vendue ni partagée à des fins commerciales.

## Hébergement et prestataires

Le service et son authentification (Supabase) tournent sur un serveur de l'exploitant. Le lien de connexion est envoyé par un prestataire d'envoi d'e-mails, qui ne reçoit que votre adresse. Les fournisseurs d'IA sont ceux que vous choisissez (voir plus haut).

## Export et suppression, en libre-service

- **Exporter** : dans « Mon compte », « Télécharger l'export » vous donne un fichier avec vos projets, études, réponses et réglages (sans la clé IA).
- **Supprimer** : dans « Mon compte », « Supprimer mon compte » efface immédiatement vos contenus et votre clé IA, et ferme votre session ; toute connexion à ce compte, ou avec la même adresse, est ensuite refusée sans limite de durée. Une adresse supprimée ne peut plus être réutilisée sur ce service ; écrivez à l'exploitant (pierre.armanet.pa@gmail.com) pour la réactiver, ou pour faire effacer aussi votre adresse du service de connexion. Les sauvegardes du serveur sont renouvelées en continu : une copie peut y subsister quelques jours avant de disparaître.
- **Clé IA** : dans « Ma clé IA », vous pouvez la remplacer ou la supprimer à tout moment.

## Vos droits

Accès, rectification, effacement, portabilité, opposition : utilisez l'export et la suppression ci-dessus, ou écrivez à pierre.armanet.pa@gmail.com. Vous pouvez aussi saisir la CNIL.

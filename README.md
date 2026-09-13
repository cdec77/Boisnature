# Maison en Photos 🌴

PWA légère pour classer et projeter en plein écran des photos de pièces meublées. Les pièces initiales sont : Rangement, Salle à manger, Chambre, Salon, Terrasse, Bureau et Salle de bain.

Les photos **ne sont jamais copiées** dans le navigateur : l'application garde seulement une référence vers le dossier ou les fichiers choisis sur votre appareil, et va les relire directement à chaque affichage.

## Déploiement sur GitHub Pages

1. Créez un dépôt GitHub (public ou privé avec Pages activé) et placez-y tout le contenu de ce dossier (`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `icons/`) **à la racine**.
2. Dans le dépôt : **Settings → Pages → Build and deployment → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Attendez la publication (quelques minutes), puis ouvrez l'URL fournie (`https://votre-compte.github.io/votre-depot/`).
4. Sur mobile (Android) ou sur ordinateur, votre navigateur proposera **« Installer l'application »** / **« Ajouter à l'écran d'accueil »** : l'app se comporte alors comme une application native, en plein écran.

> ⚠️ Le site doit être servi en HTTPS (ce que fait GitHub Pages automatiquement) : la sélection de dossiers ne fonctionne qu'en contexte sécurisé.

## Ce qui fonctionne selon l'appareil — à savoir avant de se lancer

C'est le point technique le plus important, et je préfère être direct dessus plutôt que de vous laisser le découvrir en testant :

| Appareil / navigateur | Choix d'un **dossier**, sous-dossiers inclus | Mémorisation du choix au retour |
|---|---|---|
| **Ordinateur** (Windows/macOS/Linux) — Chrome, Edge, Opera | ✅ Oui | ✅ Oui (juste une autorisation à reconfirmer, sans tout resélectionner) |
| **Android** — Chrome récent | ✅ Oui (parfois avec une petite ré-autorisation à chaque visite) | ✅ Oui |
| **iPhone / iPad** — Safari (y compris installée en PWA) | ❌ Non | ❌ Non |
| **Firefox** (tous appareils) | ❌ Non | ❌ Non |

Cette limite ne vient pas de l'application mais du navigateur : seuls les navigateurs basés sur Chromium (Chrome, Edge…) exposent une API permettant à un site web de retenir l'accès à un vrai dossier du disque d'une visite à l'autre (l'« File System Access API »). Safari (iOS/iPadOS) et Firefox ne l'implémentent pas, et Apple n'a pour l'instant pas annoncé de projet en ce sens.

**Conséquence concrète :**
- Sur **ordinateur** et sur **Android/Chrome** : vous choisissez un dossier une fois (avec ses sous-dossiers), et l'application le retrouve toute seule à chaque réouverture — c'est l'expérience que vous décriviez.
- Sur **iPhone/iPad** (Photos) ou dans **Firefox** : vous sélectionnez des photos individuellement à chaque visite pour une pièce (bouton « 🖼️ Choisir des photos »). Rien n'est copié pour autant — le navigateur lit juste le fichier au moment où vous le choisissez — mais il faut resélectionner, car iOS ne permet pas à un site web de garder un accès permanent à votre photothèque.
- Le bouton « 📁 Choisir un dossier » n'apparaît que sur les navigateurs qui savent le faire correctement ; ailleurs, seul « 🖼️ Choisir des photos » est proposé (ou le sélecteur de dossier classique de Firefox, mais sans mémorisation).

Si un vrai classement persistant multi-appareils (y compris iPhone) devient indispensable, la seule solution technique serait de stocker une **copie** des photos (par exemple dans un espace de stockage cloud ou dans la base locale du navigateur) — ce qui contredit justement l'exigence « les photos restent en local, pas de copie ». Le compromis retenu ici privilégie donc le zéro-copie, avec cette limite sur iPhone/iPad.

## Formats d'image

Les formats `jpg`, `jpeg`, `png`, `webp`, `gif`, `bmp`, `avif` s'affichent partout. Le format **HEIC/HEIF** (par défaut sur iPhone) s'affiche nativement dans **Safari**, mais pas dans **Chrome/Edge** : sur ces navigateurs, une photo HEIC apparaîtra comme illisible. Si vous alimentez l'app depuis un PC avec des photos venant d'un iPhone, pensez à les exporter en JPEG (réglage possible dans l'app Photos de l'iPhone : *Réglages → Appareil photo → Formats → « Le plus compatible »*).

## Fonctionnalités

- Barre de pièces en haut, personnalisable (ajout, renommage, changement d'icône, suppression via le petit ✎).
- Chaque pièce garde en mémoire ses propres dossiers et fichiers sur Chrome/Edge, avec ajout et retrait au fil du temps. Retirer une photo de l'application ne supprime jamais le fichier d'origine.
- Balayage **récursif** des sous-dossiers (sur les navigateurs compatibles).
- Diaporama plein écran : flèches, glissé au doigt, clavier (← →, espace), lecture automatique à vitesse réglable, mélange aléatoire, bouton plein écran, rafraîchissement du dossier.
- Fonctionne hors-ligne pour l'habillage de l'app (les photos, elles, sont toujours lues en direct depuis votre appareil).

## Structure du projet

```
index.html      Structure de la page
style.css       Habillage « Antilles / bois exotique »
app.js          Logique (pièces, accès fichiers, diaporama)
sw.js           Service worker (cache de l'app uniquement)
manifest.json   Manifeste PWA (installation, icônes)
icons/          Icônes de l'application
```

## Régénérer les icônes

Le fichier `images2.jpg` sert de visuel source. Lancez `./generate-icons.sh images2.jpg` pour recréer les favicons, l'icône Apple Touch ainsi que les icônes PWA standard et maskables dans `icons/`. Le script nécessite ImageMagick (`magick` ou `convert`).

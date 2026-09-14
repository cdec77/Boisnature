# Maison en Photos — V6 Antilles

Décompresser puis servir ce dossier avec HTTPS, ou en local avec `python3 -m http.server 8765`, puis ouvrir http://localhost:8765. Ne pas lancer index.html en file://.

Pour mettre à jour une installation existante, remplacer les fichiers sur la même origine et au même chemin. Les clés localStorage et IndexedDB sont conservées. Ne pas effacer les données du site. Les sélections manuelles restent limitées à la session, comme auparavant. Le cache applicatif porte une nouvelle version.

- Ajouter une pièce : bouton à droite du bandeau, réduit à + sur petit écran.
- Zoom : pincer la photo, déplacer à un doigt une fois agrandie ; boutons −, pourcentage et + pour le clavier et la souris. Double-clic : 200 % / 100 %. Le zoom revient à 100 % au changement de photo. Le pincement arrête la lecture automatique.
- Retrait multiple : bouton ☑, cocher les photos ou tout sélectionner, puis « Retirer la sélection ». Une confirmation indique le nombre. Aucun fichier original n’est supprimé. Les aperçus de formats non pris en charge par le navigateur peuvent être indisponibles ; les noms restent sélectionnables.
- La barre inférieure défile horizontalement sur téléphone pour accéder à toutes les commandes. Le plein écran reste disponible.

Le thème utilise des polices système, sans chargement Google Fonts. Toutes les ressources originales, dont le convertisseur HEIC et sa licence, sont incluses.

Consulter RAPPORT-TESTS.md pour les résultats et les limites de validation.

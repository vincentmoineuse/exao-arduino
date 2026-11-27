# EXAO Arduino — Lycée du Hainaut

Appli web d'acquisition pour les boîtiers Arduino Uno + shield Grove du laboratoire de physique-chimie :
température (3 sondes DS18B20), pression (MPX5700AP), intensité sonore (Grove Loudness), voltmètre-ampèremètre (0-24 V, 0-5 A, continu et alternatif).
Le boîtier branché est reconnu automatiquement à partir des lignes série (115 200 bauds).

- **En ligne (PWA installable)** : https://vincentmoineuse.github.io/exao-arduino/
  PC : Chrome ou Edge. Android : Chrome + Arduino Uno officielle + adaptateur OTG (WebUSB). iPhone/iPad : non pris en charge.
- **Clé USB (sans réseau)** : dossier `app` (copie des fichiers de l'appli) + `cle-usb/Lancer EXAO.bat` + `cle-usb/LISEZMOI.txt`.

| Boîtier | Ligne envoyée par l'Arduino |
|---|---|
| Température | `T;T1;T2;T3` (`NA` si sonde absente) |
| Pression | `P;kPa;CAN` |
| Intensité sonore | `S;rms;crête_à_crête;moyenne` |
| Voltmètre-ampèremètre | `M;Umoy;Ueff;Imoy;Ieff;f;sat` et `CAL;zU;zI;gU;gI` (commandes `ZU`, `ZI`, `GU…`, `GI…`, `RAZ`) |
| Vitesse du son (page `vitesse_son.html`) | `T;médiane;min;max;n` |

Après une modification des fichiers, augmenter `VERSION` dans `sw.js` pour que les appareils récupèrent la nouvelle version.

Laboratoire de physique chimie du lycée du Hainaut — Vincent Moineuse, technicien de recherche et formation.

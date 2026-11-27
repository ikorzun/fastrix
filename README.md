# Fastrix

Fastrix: FPS Arena Shooter Online, браузерный шутер для телефонов и ПК под Playgama.

## Сборка под Playgama

Источник игры пока один: однофайловая версия арены, которую ведёт основная ветка
(`/mnt/project-files/shooter_builds/shooter_arena_vNN.html`). Эта папка её не правит,
а только собирает из неё архив для Playgama. Код игры переедет сюда на этапе 2 (сетевой рефакторинг).

Сборка (из корня репозитория):

    python3 -I tools/build.py /mnt/project-files/shooter_builds/<файл>.html builds/<имя>

Что делает: подключает Playgama Bridge (SDK первым в `<head>`, игра стартует только после
`bridge.initialize()` и загрузки сохранения; localStorage игры идёт в `bridge.storage` одним
ключом `fastrix_save`; пауза и звук платформы; `game_ready`; межстраничная реклама после
каждого матча; код слоя в `tools/bridge_boot.js`, `--no-bridge` выключает). Затем three.js r128 и шрифты (Bangers, Nunito, Fira Sans Extra Condensed) кладёт внутрь архива вместо
cdnjs и Google Fonts (требование 1.2.5), добавляет `<!doctype>` и `charset`,
кладёт `playgama-bridge-config.json`, если он есть, и лицензии; печатает, что
ещё не проходит модерацию. Код завершения 1, если остались загрузки из сети.

- `vendor/` — three.min.js 0.128.0 (MIT), woff2 Bangers, Nunito и Fira Sans Extra Condensed (OFL 1.1), латиница и кириллица (с v19).
- `builds/` — готовые архивы и скриншот проверки.
- План целиком: https://claude.ai/artifact/TYNxgQ7HbewTMGesd9XYZd

## Ссылка для тестеров (GitHub Pages)

Игра без Playgama (без Bridge и рекламы, сохранения в браузере): https://ikorzun.github.io/fastrix/
Обновить на новую версию (ссылка та же):

    tools/publish_pages.sh /mnt/project-files/shooter_builds/shooter_arena_vNN.html vNN

Скрипт собирает `build.py --no-bridge` и кладёт результат в ветку `gh-pages`.

## Прототип онлайна (этап 2)

`tools/mp_patch.js` + `tools/build_mp.py`: та же арена, где соперники — живые игроки. Каждый клиент
сам ведёт своего игрока; попадание решает стрелок и шлёт его жертве (`hit`), жертва применяет урон.
Состояние 15 раз в секунду, чужие игроки рисуются с задержкой 120 мс (интерполяция). Компьютерные
соперники в этом режиме пока выключены. `publish_pages.sh` кладёт эту сборку в `/mp/`:

- https://ikorzun.github.io/fastrix/mp/ — комнаты Playgama Bridge (два устройства);
- https://ikorzun.github.io/fastrix/mp/?mp=local — две вкладки одного браузера, без серверов.

Не синхронизируются пока: гранаты и лазер у чужого игрока (урон проходит, анимации нет), замедление
времени, общий таймер матча, подсадка компьютерных соперников на пустые места.

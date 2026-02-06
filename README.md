# Git-Cleaner

![Node.js](https://img.shields.io/badge/Node.js-green) ![License](https://img.shields.io/badge/License-MIT-blue)

**Git-Cleaner** es una herramienta CLI interactiva diseñada para mantener la higiene de tus repositorios Git. Ayuda a identificar y eliminar ramas antiguas de manera segura, aplicando filtros inteligentes por autor, fecha y estado de integración (merge).

## 🚀 Características

- **Modo Interactivo**: Menú CLI fácil de usar (sin necesidad de recordar flags).
- **Modo Test (Dry-Run)**: Visualiza qué ramas se eliminarían antes de tocar nada.
- **Filtros Flexibles**:
  - **Por Autor**: Limpia solo tus ramas (`TARGET_USERS`) o todas MENOS las de ciertos usuarios (`EXCLUDE_USERS`).
  - **Por Estado**: Filtra solo ramas que ya han sido mergeadas a `main`/`master` o revisa todas las antiguas.
  - **Antigüedad**: Focaliza ramas con inactividad (configurable, default 1 mes).
- **Protección**: Lista de ramas protegidas que nunca se eliminarán (ej: `main`, `dev`).

## 🛠️ Instalación

1.  Clona el repositorio.
2.  Instala las dependencias:

```bash
npm install
# o
yarn
```

## ⚙️ Configuración

1.  Copia el archivo de ejemplo:
    ```bash
    cp ".env copy" .env
    ```
2.  Edita el `.env` con tus preferencias:

| Variable | Descripción | Ejemplo |
| :--- | :--- | :--- |
| `TARGET_USERS` | Lista de autores a limpiar (separados por `,` o `\|`). | `jdoe\|asmith` |
| `EXCLUDE_USERS` | (Opcional) Usuarios a **excluir**. Si se define, `TARGET_USERS` se ignora. | `admin\|bot` |
| `PROTECTED_BRANCHES` | Ramas que nunca se borrarán. | `main,master,release` |
| `GIT_PATH` | Ruta absoluta al repo (opcional). | `/Users/me/repo` |

## ▶️ Uso

Ejecuta el script:

```bash
npm start
# o
node index.js
```

Sigue los pasos en pantalla:

1.  **Selecciona el Modo**:
    - `Modo Test`: Lista las ramas candidatas (Recomendado).
    - `Modo Acción`: Procede a eliminar (con confirmación).

2.  **Selecciona el Filtro**:
    - `Todas las ramas antiguas`: Aplica filtros de fecha y autor.
    - `Solo ramas mergeadas`: Adicionalmente verifica si la rama existe en `origin/main` o `origin/master`.

## 🛡️ Seguridad

- La herramienta **nunca** elimina ramas en `PROTECTED_BRANCHES`.
- En `Modo Acción`, siempre pide una confirmación final explícita antes de ejecutar `git push origin :branch`.
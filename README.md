# ig-seguidores
## Instalación

**Para usarla:** bajá el instalador `IG Seguidores Setup` desde la sección [Releases](../../releases) y ejecutalo.

Si Windows muestra "Windows protegió tu PC", tocá **Más información** y después **Ejecutar de todas formas**. Aparece porque la app no tiene firma digital.

**Para desarrollarla:**

```
npm install
npm start
```

Para generar el instalador (en una terminal como administrador):

```
npm run dist
```

## Cómo se usa

1. Tocá **Iniciar sesión en Instagram** y entrá con tu cuenta en la ventana que se abre.
2. Tocá **Analizar mi cuenta** y esperá a que termine de cargar.
3. Revisá las listas, filtralas o exportalas.

La pestaña *Me dejaron* muestra datos a partir del segundo análisis, porque Instagram no guarda historial de quién dejó de seguirte y la app lo calcula comparando con la vez anterior.

Como alternativa, podés usar **Cargar export oficial** con los archivos JSON que descargás desde *Configuración → Tu actividad → Descargar tu información*.

## Aviso

Proyecto personal y educativo, sin relación con Instagram ni Meta. Consulta datos de tu propia cuenta a través de la API interna del sitio, que puede cambiar sin aviso. Un uso muy frecuente puede hacer que Instagram limite tu cuenta temporalmente, así que conviene analizar de vez en cuando. Usala bajo tu propia responsabilidad.

## Tecnologías

Electron, JavaScript, HTML y CSS.


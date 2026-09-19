Prompt used to create this application:

```md
Crea un directorio llamado guanaco. Crearas una aplicación ahí dentro.

Escribe todo el código, GUI y documentación en inglés. Habla conmigo en español.

Utiliza unicamente código HTML, CSS y JavaScript sin necesidad de usar un servidor NodeJS. Debe tener compatibilidad para servir con `python -m http.server`.

La aplicación es un orquestador de solicitudes para una inteligencia artificial descargada y alojada en Ollama. Busca en Internet e informate todo lo que puedas de la documentación de Ollama y su uso por medio de Endpoints HTTP y CLI.

La aplicación, de una sóla página, debe tener 3 vistas.

La primera vista es el orquestador de solicitudes. En esta, con un botón, puedo crear una pequeña ventana donde ingreso un prompt que es automaticamente enviado a la IA en Ollama si no hay otra en cola. Si creo otra de esas ventanas para enviar un prompt y envio otro prompt, esta debe colocarse en cola y esperar la solicitud anterior a terminar. Este sistema de cola es administrado por la aplicación misma, no por Ollama. Puedo crear n cantidad de ventanas para enviar un prompt a la cola.

La segunda vista es el modo chat de esas pequeñas ventanas. Al darle clic a una de las ventanas, ya sea que haya recibido su respuesta o no, abre un chat integrado completo de ese chat para continuarlo con normalidad. Obviamente si escribo un mensaje y fuera de esa vista ya hay otra solicitud, mostrará que se ha agregado esta solicitud a la cola y está en espera de recibir su turno.

La tercera vista es la de configuración del servidor Ollama. Aquí quiero que coloques 6 configuraciones principales que aplican de forma global a todos los nuevos chats que se vayan a crear: 1) URL del servidor Ollama, puede ser local o externo. 2) Nombre del modelo, se muestran en un dropdown los disponibles. 3) La configuración por defecto de num_ctx. 4) la configuración por defecto de num_predict. 5) El SystemPrompt a enviar. 6) Habilitar o deshabilitar el modo Think. Además de esas 6 caracteristicas personalizables, agrega otras que quieras en una sección de "Advanced Configuration".

En esa tercera vista, como dije, es la configuración global que se aplica en cada ventana nueva creada en la primera vista, sin embargo, agrega un pequeño botón para aplicar una configuración personalizada en esa ventana unica. Cambiala de color para distinguir si está usando la configuración global o una personalizada unica para esa unica ventana.

La configuración global debe ser posible exportala o importarla en JSON para reproducirla en otro browser. Guarda la configuración global personalizada en el localStorage. Agrega un botón para restaurar valores por defecto.

Documenta el código con comentarios enfocados para otra sesión de Codex o de Claude Code con contexto limpio. Escribelo escalable y modularizado para que sea posible agregar caracteristicas como si armar un juguete de lego se trátase, asegurando la versatilidad y escalabilidad de nuevas funciones y cambios.

Si necesitas usar Ollama para tus pruebas, utiliza la instancia local hosteada en esta misma PC Linux Mint. Utiliza el modelo `hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0` disponible para las pruebas (ya que es el modelo más pequeño disponible).

No pares hasta que todos los puntos anteriores estén completos y funcionales.

Cuando termines todo lo anterior, documenta todo lo relevante en el fichero AGENTS.md enfocado a explicar la aplicación para otra IA sin contexto sobre la aplicación sin importar si es Codex o Claude Code.
```

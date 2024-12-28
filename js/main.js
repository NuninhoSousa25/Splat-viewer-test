// Check if GaussianSplattingMesh is loaded
if (typeof BABYLON.GaussianSplattingMesh === 'undefined') {
    console.error("GaussianSplattingMesh is not loaded correctly.");
} else {
    console.log("GaussianSplattingMesh loaded successfully.");
}

// ======================================================
// 1) CONFIGURATION OBJECT (Suggestion #13)
// ======================================================
const config = {
    defaultModelUrl: "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat",
    camera: {
        alpha: -Math.PI / 4,
        beta:  Math.PI / 3,
        radius: 4,
        upperRadiusLimit: 7.0,
        lowerRadiusLimit: 2.0, // Increased from 1.1 to 2.0 to prevent camera from getting too close
        minZ: 0.1,
        maxZ: 1000
    },
    engine: {
        // (Suggestion #10) Fine-tune engine creation
        preserveDrawingBuffer: true,
        stencil: true,
        disableWebGL2Support: false,
        antialias: false // Disable built-in anti-aliasing to use FXAA
    }
};

let engine, scene, camera;
let currentModel = null;
let currentModelType = null;
let pipeline = null; // For post-process reuse/disposal (Suggestion #9)

let isControlPanelVisible = false; // (Suggestion #5)

// ======================================================
// 2) ORGANIZE TOP-LEVEL FUNCTIONS
//    (Scene init, camera setup, picking logic, animations, UI, model loading, etc.)
// ======================================================

/** Initialize Scene and Engine */
function initializeEngineAndScene() {
    const canvas = document.getElementById("renderCanvas");
    // Using config to fine-tune engine
    engine = new BABYLON.Engine(canvas, true, {
        preserveDrawingBuffer: config.engine.preserveDrawingBuffer,
        stencil: config.engine.stencil,
        disableWebGL2Support: config.engine.disableWebGL2Support,
        antialias: config.engine.antialias // Set antialias based on config
    });
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color3(0.1, 0.1, 0.1);
    return { engine, scene, canvas };
}

/** Set up camera (Suggestion #6: centralize constraints) */
function setupCamera(scene, canvas) {
    const cam = new BABYLON.ArcRotateCamera(
        "Camera",
        config.camera.alpha,
        config.camera.beta,
        config.camera.radius,
        new BABYLON.Vector3(0, 0, 0),
        scene
    );
    cam.attachControl(canvas, true);
    cam.minZ = config.camera.minZ;
    cam.maxZ = config.camera.maxZ;
    cam.panningSensibility = 1000;
    cam.angularSensibilityX = 2500;
    cam.angularSensibilityY = 2500;
    cam.wheelPrecision = 100;
    cam.panningInertia = 0.6;
    cam.useAutoRotationBehavior = true;

    if (cam.useAutoRotationBehavior) {
        const autoRotationBehavior = cam.autoRotationBehavior;
        autoRotationBehavior.idleRotationWaitTime = 5000;
        autoRotationBehavior.idleRotationSpeed = 0.01;
        autoRotationBehavior.idleRotationSpinUpTime = 3000;
    }

    // Constraints on each frame
    scene.onBeforeRenderObservable.add(() => {
        // limit vertical angle
        cam.beta = Math.max(Math.min(cam.beta, 1.75), 0.2);
        // enforce min radius
        cam.radius = Math.max(cam.radius, config.camera.lowerRadiusLimit);

        // enforce upper radius if defined
        if (cam.upperRadiusLimit !== undefined) {
            cam.radius = Math.min(cam.radius, cam.upperRadiusLimit);
        }
    });

    // Set initial limits after scene is ready
    scene.executeWhenReady(() => {
        cam.radius = config.camera.radius;
        cam.upperRadiusLimit = config.camera.upperRadiusLimit;
        cam.lowerRadiusLimit = config.camera.lowerRadiusLimit;
        cam.alpha = config.camera.alpha;
        cam.beta = config.camera.beta;
        cam.target = new BABYLON.Vector3(0, 0, 0);
    });

    return cam;
}

// ======================================================
// 3) STREAMLINE PICKING LOGIC (Suggestion #3)
// ======================================================
function setMeshesPickable(mesh) {
    if (mesh instanceof BABYLON.Mesh) {
        mesh.isPickable = true;
        mesh.getChildMeshes().forEach(child => {
            child.isPickable = true;
        });
    }
}

function getPickResult(scene, camera, pointerX, pointerY) {
    // 1) Direct pick with isPickable
    let pickResult = scene.pick(
        pointerX,
        pointerY,
        (mesh) => mesh.isPickable,
        false,
        camera
    );

    // 2) If no hit, try isVisible
    if (!pickResult || !pickResult.hit) {
        pickResult = scene.pick(
            pointerX,
            pointerY,
            (mesh) => mesh.isVisible,
            true,
            camera
        );
    }

    // 3) If still no hit, pick with ray
    if (!pickResult || !pickResult.hit) {
        const ray = scene.createPickingRay(pointerX, pointerY, BABYLON.Matrix.Identity(), camera);
        const raycastResult = scene.pickWithRay(ray);
        if (raycastResult && raycastResult.hit) {
            pickResult = raycastResult;
        }
    }

    return pickResult;
}

// ======================================================
// 4) and 5) ADJUST UI UPDATES IN THE RENDER LOOP (THROTTLE)
//    and AVOID DOING WORK IF THE PANEL IS HIDDEN
// ======================================================
function setupUIUpdates(scene) {
    const fpsCounter        = document.getElementById("controlPanelFps");
    const resolutionCounter = document.getElementById("controlPanelResolution");
    const verticesCounter   = document.getElementById("controlPanelVertices");

    let lastUpdateTime = 0;
    scene.onBeforeRenderObservable.add(() => {
        // throttle to ~ every 450ms
        const now = performance.now();
        if (now - lastUpdateTime > 450 && isControlPanelVisible) {
            lastUpdateTime = now;
            const fps = engine.getFps();
            const width = engine.getRenderWidth();
            const height = engine.getRenderHeight();
            const totalVertices = getTotalVertices(scene);

            fpsCounter.textContent = fps.toFixed(2);
            resolutionCounter.textContent = `${width} x ${height}`;
            verticesCounter.textContent = totalVertices;
        }
    });
}

// ======================================================
// 7) PROVIDE A SINGLE CAMERA ANIMATION FUNCTION
// ======================================================
function animateCameraTo(camera, newTarget, newRadius, duration = 30, onAnimationEnd) {
    const animationGroup = new BABYLON.AnimationGroup("cameraCenterAnimation");

    // Target animation
    const targetAnimation = new BABYLON.Animation(
        "targetPan",
        "target",
        30,
        BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
        BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT
    );
    targetAnimation.setKeys([
        { frame: 0, value: camera.target.clone() },
        { frame: duration, value: newTarget }
    ]);

    // Radius animation
    const radiusAnimation = new BABYLON.Animation(
        "radiusAdjust",
        "radius",
        30,
        BABYLON.Animation.ANIMATIONTYPE_FLOAT,
        BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT
    );
    radiusAnimation.setKeys([
        { frame: 0, value: camera.radius },
        { frame: duration, value: newRadius }
    ]);

    animationGroup.addTargetedAnimation(targetAnimation, camera);
    animationGroup.addTargetedAnimation(radiusAnimation, camera);
    animationGroup.normalize(0, duration);

    if (onAnimationEnd) {
        animationGroup.onAnimationEndObservable.addOnce(onAnimationEnd);
    }

    return animationGroup;
}

// ======================================================
// 8) KEEP MODEL LOADING LOGIC GENERIC
// ======================================================
function disposeCurrentModel() {
    if (!currentModel) return;

    if (currentModelType === 'splat' || currentModelType === 'mesh') {
        currentModel.dispose();
    }
    currentModel = null;
    currentModelType = null;
}

async function loadSplatModel(scene, url) {
    console.log(`Loading .splat/.ply model from URL: ${url}`);

    // Create the GaussianSplattingMesh instance
    const splatMesh = new BABYLON.GaussianSplattingMesh("mySplatMesh", null, scene);
    console.log("GaussianSplattingMesh instance created:", splatMesh);

    // Load the .splat (or .spz) file asynchronously
    await splatMesh.loadFileAsync(url);
    console.log("Model file loaded successfully.");

    // Return the loaded mesh
    return splatMesh;
}

async function loadModel(scene, modelSource) {
    disposeCurrentModel();

    // Show loading spinner
    const spinner = document.getElementById("loadingSpinner");
    if (spinner) spinner.style.display = "block";  // Show spinner

    let url = '';
    let extension = '';

    if (modelSource instanceof File) {
        url = URL.createObjectURL(modelSource);
        extension = modelSource.name.split('.').pop().toLowerCase();
    } else if (typeof modelSource === 'string') {
        url = modelSource;
        try {
            const urlObj = new URL(url);
            const path = urlObj.pathname;
            extension = path.split('.').pop().toLowerCase();
        } catch (e) {
            console.error("Invalid URL:", url);
            throw new Error("Invalid URL format");
        }
    } else {
        throw new Error("Unsupported model source type");
    }

    console.log(`Attempting to load model from ${url} with extension .${extension}`);

    try {
        if (extension === 'spz') {
            console.log("Loading as .spz using SceneLoader.ImportMeshAsync");
            const result = await BABYLON.SceneLoader.ImportMeshAsync(null, "", url, scene);
            currentModel = result.meshes[0];
            currentModel.position.y = 0;
            currentModelType = 'mesh';
            console.log("Successfully loaded .spz model:", currentModel);
        } else if (extension === 'splat' || extension === 'ply') {
            console.log(`Loading as .${extension} using GaussianSplattingMesh`);
            currentModel = await loadSplatModel(scene, url);
            currentModelType = 'splat';
            console.log("Successfully loaded .splat/.ply model:", currentModel);
        } else {
            throw new Error("Unsupported file format");
        }

        // Ensure all meshes are pickable
        setMeshesPickable(currentModel);

        // Default scale
        scaleModel(1.0);
    } catch (err) {
        console.error("Failed to load model:", err);
        alert("Failed to load model. Creating fallback box.");

        currentModel = BABYLON.MeshBuilder.CreateBox("fallbackBox", {}, scene);
        currentModelType = 'mesh';
    }

    // Hide loading spinner
    if (spinner) spinner.style.display = "none"; // Hide spinner

    return currentModel;
}


// ======================================================
// 9) REUSE / DISPOSE POST-PROCESSING PIPELINE
// ======================================================
function addPostEffects(scene, camera) {
    // If pipeline already exists, dispose
    if (pipeline) {
        pipeline.dispose();
        pipeline = null;
    }

    pipeline = new BABYLON.DefaultRenderingPipeline(
        "defaultPipeline",
        false,
        scene,
        [camera]
    );

    // Sharpen Settings
    pipeline.sharpenEnabled   = true;
    pipeline.sharpen.edgeAmount = 0.92; // Set to 0.92 as per requirement

    // Enable FXAA (Anti-Aliasing) by default
    pipeline.fxaaEnabled = true;
}


// ======================================================
// Helper to count total vertices
// ======================================================
function getTotalVertices(scene) {
    return scene.meshes.reduce((total, mesh) => {
        return total + (mesh.getTotalVertices() || 0);
    }, 0);
}

// ======================================================
// The scale function (used after model loading)
// ======================================================
function scaleModel(scaleValue) {
    if (!currentModel) {
        console.warn("No model loaded to scale");
        return;
    }

    try {
        currentModel.scaling.set(scaleValue, scaleValue, scaleValue);
    } catch (error) {
        console.error("Error scaling model:", error);
    }
}

// ======================================================
// Double-click pan setup (uses streamlined picking logic + camera animation)
// ======================================================

function setupDoubleClickPan(scene, camera) {
    // Animation lock flag to prevent overlapping animations
    let isAnimating = false;

    // Handle Double-Click for Desktop
    scene.onPointerObservable.add((pointerInfo) => {
        if (
            pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOUBLETAP &&
            pointerInfo.event.button === 0
        ) {
            handleDoubleTap(scene, camera, isAnimating, (animating) => { isAnimating = animating; });
        }
    });

    // Handle Double-Tap for Touch Devices
    let lastTap = 0;
    const doubleTapThreshold = 300; // ms

    scene.onPointerObservable.add((pointerInfo) => {
        if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERDOWN) {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTap;
            if (tapLength < doubleTapThreshold && tapLength > 0) {
                handleDoubleTap(scene, camera, isAnimating, (animating) => { isAnimating = animating; });
                lastTap = 0;
            } else {
                lastTap = currentTime;
            }
        }
    });
}

function handleDoubleTap(scene, camera, isAnimating, setAnimating) {
    // If an animation is already in progress, ignore the new double-click
    if (isAnimating) {
        return;
    }

    const pickResult = getPickResult(scene, camera, scene.pointerX, scene.pointerY);
    if (pickResult && pickResult.hit && pickResult.pickedPoint) {
        // Calculate appropriate radius based on distance to picked point
        const distanceToPoint = BABYLON.Vector3.Distance(camera.target, pickResult.pickedPoint);
        const targetRadius = Math.max(
            Math.min(distanceToPoint * 2, camera.upperRadiusLimit || 7.0),
            camera.lowerRadiusLimit || 2.0 // Ensure it respects the new lower limit
        );

        // Set the animation lock
        setAnimating(true);

        // Create and play the animation
        const animationGroup = animateCameraTo(camera, pickResult.pickedPoint, targetRadius, 30, () => {
            // Release the animation lock after animation ends
            setAnimating(false);
        });

        animationGroup.play();
    }
}

// ======================================================
// Create the UI and set up event handlers
// ======================================================

function setupUI(camera, scene, xrHelper) {
    const controlPanel = document.createElement("div");
    controlPanel.id = "controlPanel";
    controlPanel.className = "control-panel";

    controlPanel.innerHTML = `
        <div id="controlPanelHeader" class="control-panel-header">
            <h3>Controls</h3>
            <span id="toggleArrow" class="accordion-toggle">+</span>
        </div>
        <div id="controlPanelContent" class="control-panel-content" style="display: none;">
            <!-- Control Info Section -->
            <div class="control-info">
                <ul style="margin: 0; padding-left: 20px; list-style-type: square;">
                    <li>Double Left Click: Center on selection</li>
                    <li>Right click: Pan</li>
                    <li>Left click and drag: Orbit</li>
                    <li>Scroll: Zoom</li>
                </ul>
            </div>

            <!-- Scene Info Section as a Button -->
            <button id="toggleSceneInfo" class="section-toggle-button">Scene Info</button>
            <div id="sceneInfoContent" style="display: none; margin-bottom: 15px;">
                <p>Fps: <span id="controlPanelFps">0</span></p>
                <p>Resolution: <span id="controlPanelResolution">0 x 0</span></p>
                <p>Total Vertices: <span id="controlPanelVertices">0</span></p>
            </div>

            <!-- Settings Separator -->
            <div class="settings-separator"></div>

            <!-- Settings Title -->
            <div class="settings-title">Settings</div>

            <!-- Settings Toggle Buttons -->
            <div class="control-group">
                <button id="toggleModelSettings" class="section-toggle-button">Toggle Model Settings</button>
                <button id="toggleCameraSettings" class="section-toggle-button">Toggle Camera Settings</button>
            </div>

            <!-- Model Settings Section -->
            <div id="modelSettings" class="settings-section" style="display: none;">
                <div class="model-loader">
                    <input type="file" id="modelLoader" accept=".splat, .ply, .spz" style="margin-bottom: 10px;">
                    <button id="loadModelFileButton">Load from File</button>
                </div>
                <div class="model-loader">
                    <input type="text" id="modelUrlInput" placeholder="Enter model URL" style="width: 100%; margin-bottom: 10px;">
                    <button id="loadModelUrlButton">Load from URL</button>
                </div>
                <div class="control-group">
                    <h6>Model Scale</h6>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <input type="range" id="modelScaleSlider" min="0.1" max="5" step="0.1" value="1" style="flex-grow: 1;">
                        <span id="modelScaleValue" style="width: 40px; text-align: right;">1.0x</span>
                    </div>
                </div>
            </div>

            <!-- Camera Settings Section -->
            <div id="cameraSettings" class="settings-section" style="display: none;">
                <div class="control-group">
                    <label>
                        <input type="checkbox" id="autoRotateToggle" ${camera.useAutoRotationBehavior ? "checked" : ""}>
                        Enable Auto-Rotate
                    </label>
                </div>
                <div class="control-group">
                    <h6>Max Camera Distance</h6>
                    <label>
                        <input type="number" id="maxRadiusInput" value="${config.camera.upperRadiusLimit}" style="width: 100%;">
                    </label>
                </div>
                <div class="control-group">
                    <h6>Sharpen</h6>
                    <div style="margin-left: 20px;">
                        <label for="sharpenEdgeAmount">Edge Amount: <span id="sharpenEdgeAmountValue">0.92</span></label>
                        <input type="range" id="sharpenEdgeAmount" min="0" max="1" step="0.01" value="0.92">
                    </div>
                </div>
                <div class="control-group">
                    <h6>Pixel Ratio</h6>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <input type="range" id="pixelRatioSlider" min="0.5" max="2.0" step="0.1" value="1.0" style="flex-grow: 1;">
                        <span id="pixelRatioValue" style="width: 40px; text-align: right;">1.0x</span>
                    </div>
                </div>
            </div>

            <!-- Loading Spinner -->
            <div id="loadingSpinner">
                <div></div>
            </div>
        </div>
    `;
    document.body.appendChild(controlPanel);

    // Toggle entire control panel display
    const headerEl = document.getElementById("controlPanelHeader");
    const contentEl = document.getElementById("controlPanelContent");
    const arrowEl   = document.getElementById("toggleArrow");

    headerEl.addEventListener("click", () => {
        isControlPanelVisible = !isControlPanelVisible;
        contentEl.style.display = isControlPanelVisible ? "block" : "none";
        arrowEl.textContent = isControlPanelVisible ? "−" : "+";
    });

    // Handle Settings Toggle Buttons
    const toggleModelSettingsBtn = document.getElementById("toggleModelSettings");
    const toggleCameraSettingsBtn = document.getElementById("toggleCameraSettings");
    const modelSettingsSection = document.getElementById("modelSettings");
    const cameraSettingsSection = document.getElementById("cameraSettings");

    toggleModelSettingsBtn.addEventListener("click", () => {
        toggleSettingsSection(modelSettingsSection);
    });

    toggleCameraSettingsBtn.addEventListener("click", () => {
        toggleSettingsSection(cameraSettingsSection);
    });

    /**
     * Toggles a settings section by showing/hiding it
     * @param {HTMLElement} section - The settings section to toggle
     */
    function toggleSettingsSection(section) {
        if (section.style.display === "none") {
            section.style.display = "block";
        } else {
            section.style.display = "none";
        }
    }

    // Handle "Scene Info" Toggle Button
    const toggleSceneInfoBtn = document.getElementById("toggleSceneInfo");
    const sceneInfoContent = document.getElementById("sceneInfoContent");

    toggleSceneInfoBtn.addEventListener("click", () => {
        toggleSceneInfo();
    });

    /**
     * Toggles the Scene Info section by showing/hiding it
     */
    function toggleSceneInfo() {
        if (sceneInfoContent.style.display === "none") {
            sceneInfoContent.style.display = "block";
        } else {
            sceneInfoContent.style.display = "none";
        }
    }

    // Handle auto-rotate toggle
    const autoRotateToggle = document.getElementById("autoRotateToggle");
    autoRotateToggle.addEventListener("change", (e) => {
        camera.useAutoRotationBehavior = e.target.checked;
    });

    // Handle maxRadius input
    const maxRadiusInput = document.getElementById("maxRadiusInput");
    maxRadiusInput.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        camera.upperRadiusLimit = val;
        console.log(`Camera upperRadiusLimit set to: ${val}`);
    });

    // Model scale slider
    const modelScaleSlider = document.getElementById("modelScaleSlider");
    const modelScaleValue  = document.getElementById("modelScaleValue");
    modelScaleSlider.addEventListener("input", (e) => {
        const scaleVal = parseFloat(e.target.value);
        scaleModel(scaleVal);
        modelScaleValue.textContent = `${scaleVal.toFixed(1)}x`;
        console.log(`Model scale set to: ${scaleVal}`);
    });

    // Set up UI update loop (Suggestion #4 & #5)
    setupUIUpdates(scene);

    // ======================================================
    // Pixel Ratio Control Implementation
    // ======================================================
    const pixelRatioSlider = document.getElementById("pixelRatioSlider");
    const pixelRatioValue  = document.getElementById("pixelRatioValue");

    // Initialize the slider value to 1.0 as per requirement
    pixelRatioSlider.value = 1.0;
    pixelRatioValue.textContent = `1.0x`;
    engine.setHardwareScalingLevel(1 / 1.0); // Set scaling to 1

    pixelRatioSlider.addEventListener("input", (e) => {
        const scaleVal = parseFloat(e.target.value);
        engine.setHardwareScalingLevel(1 / scaleVal);
        pixelRatioValue.textContent = `${scaleVal.toFixed(1)}x`;
        console.log(`Pixel ratio set to: ${scaleVal}`);
    });
    // ======================================================

    // ======================================================
    // Post-Processing Filters Controls Implementation
    // ======================================================
    // Sharpen Controls (Only Edge Amount slider remains)
    const sharpenEdgeAmount = document.getElementById("sharpenEdgeAmount");
    const sharpenEdgeAmountValue = document.getElementById("sharpenEdgeAmountValue");

    sharpenEdgeAmount.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        sharpenEdgeAmountValue.textContent = val;
        if (pipeline) {
            pipeline.sharpen.edgeAmount = val;
            console.log(`Sharpen Edge Amount set to: ${val}`);
        }
    });

    return controlPanel;
}


// ======================================================
// Model-loading handlers for file or URL input
// ======================================================
function setupModelLoadingHandlers(scene) {
    // File
    const fileButton = document.getElementById("loadModelFileButton");
    fileButton.addEventListener("click", async () => {
        const fileInput = document.getElementById("modelLoader");
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            console.log(`Loading model from file: ${file.name}`);
            await loadModel(scene, file);
        } else {
            alert("Please select a .splat, .ply, or .spz file to load.");
        }
    });

    // URL
    const urlButton = document.getElementById("loadModelUrlButton");
    urlButton.addEventListener("click", async () => {
        const urlInput = document.getElementById("modelUrlInput").value;
        if (urlInput) {
            console.log(`Loading model from URL input: ${urlInput}`);
            await loadModel(scene, urlInput);
        } else {
            alert("Please provide a valid model URL.");
        }
    });
}

// ======================================================
// CreateScene function (entry point)
// ======================================================
async function createScene() {
    const { engine, scene, canvas } = initializeEngineAndScene();
    camera = setupCamera(scene, canvas);

    // Initialize WebXR
    const xrHelper = await scene.createDefaultXRExperienceAsync({
        uiOptions: {
            sessionMode: 'immersive-vr', // You can change this to 'immersive-ar' if needed
            referenceSpaceType: 'local-floor'
        },
        optionalFeatures: true
    });

    // UI
    const controlPanel = setupUI(camera, scene, xrHelper);

    // Double-click to center
    setupDoubleClickPan(scene, camera);

    // Post-effects
    addPostEffects(scene, camera);

    // Set up model loading handlers
    setupModelLoadingHandlers(scene); // <-- Ensures model loading via UI works

    // Try to load from URL param or default
    const urlParams = new URLSearchParams(window.location.search);
    const modelUrl  = urlParams.get('model');
    if (modelUrl) {
        try {
            const decodedModelUrl = decodeURIComponent(modelUrl);
            console.log(`Loading model from URL parameter: ${decodedModelUrl}`);
            await loadModel(scene, decodedModelUrl);
        } catch (error) {
            console.error("Error loading model from URL parameter:", error);
            await loadModel(scene, config.defaultModelUrl);
        }
    } else {
        console.log("Loading default model:", config.defaultModelUrl);
        await loadModel(scene, config.defaultModelUrl);
    }

    engine.runRenderLoop(() => {
        scene.render();
    });

    // Listen for resize
    window.addEventListener("resize", () => {
        engine.resize();
        console.log("Engine resized");
    });

    return scene;
}

// Finally, let’s start everything
createScene().then(() => {
    console.log("Scene created and ready!");
});

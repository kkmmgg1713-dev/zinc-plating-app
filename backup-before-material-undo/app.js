(() => {
    'use strict';

    const TOTAL_SAMPLES = 13;
    const MEASUREMENTS_PER_SAMPLE = 20;
    const MIN_MEASUREMENT = 0;
    const MAX_MEASUREMENT = 9999.9;
    const STORAGE_KEY = 'zincPlatingDataV3';
    const LEGACY_STORAGE_KEY = 'zincPlatingDataV2';
    const DATA_VERSION = 3;
    const MAX_VOICE_RETRIES = 5;
    const VOICE_RANGE_KEY = 'zincPlatingVoiceRangeV1';
    const DEFAULT_VOICE_RANGE = { min: 0, max: 500 };
    const HEALTHY_SESSION_MS = 1000;
    const QUICK_RESTART_MS = 150;
    const DUPLICATE_FINAL_MS = 400;

    let materials = [];
    let currentMaterial = 0;
    let currentSample = 0;
    let dom = {};
    let deferredInstallPrompt = null;
    let previousFocus = null;
    let activeModal = null;
    let toastTimer = null;
    let editingMaterialIndex = null;
    let pendingDeleteMaterialIndex = null;

    let recognition = null;
    let recognitionToken = 0;
    let shouldBeListening = false;
    let voiceState = 'idle';
    let voiceRetryCount = 0;
    let voiceRetryTimer = null;
    let voiceCursorIndex = null;
    let voiceHistory = [];
    let audioContext = null;
    let wakeLock = null;
    let voiceRange = { ...DEFAULT_VOICE_RANGE };

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

    function createId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return `material-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function createSampleData(sampleNumber) {
        return {
            sampleNumber,
            measurements: new Array(MEASUREMENTS_PER_SAMPLE).fill(null),
            min: null,
            avg: null
        };
    }

    function createMaterialData(materialNumber) {
        return {
            id: createId(),
            materialNumber,
            name: `자재 ${materialNumber}`,
            samples: Array.from(
                { length: TOTAL_SAMPLES },
                (_, index) => createSampleData(index + 1)
            )
        };
    }

    function validateMeasurement(value) {
        if (value === '' || value === null || value === undefined) {
            return { valid: true, value: null, message: '' };
        }

        const numericValue = typeof value === 'number'
            ? value
            : Number(String(value).trim());

        if (!Number.isFinite(numericValue)) {
            return { valid: false, value: null, message: '숫자만 입력할 수 있습니다.' };
        }
        if (numericValue < MIN_MEASUREMENT) {
            return { valid: false, value: null, message: '측정값은 0 이상이어야 합니다.' };
        }
        if (numericValue > MAX_MEASUREMENT) {
            return {
                valid: false,
                value: null,
                message: `측정값은 ${MAX_MEASUREMENT.toLocaleString('ko-KR')} μm 이하여야 합니다.`
            };
        }

        return { valid: true, value: numericValue, message: '' };
    }

    function calculateSample(sample) {
        const validValues = sample.measurements.filter(
            value => typeof value === 'number' && Number.isFinite(value)
        );

        if (validValues.length === 0) {
            sample.min = null;
            sample.avg = null;
            return;
        }

        sample.min = Math.min(...validValues);
        sample.avg = validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
    }

    function normalizeSample(rawSample, index) {
        const sample = createSampleData(index + 1);
        const rawMeasurements = Array.isArray(rawSample?.measurements)
            ? rawSample.measurements
            : [];

        sample.measurements = Array.from(
            { length: MEASUREMENTS_PER_SAMPLE },
            (_, measurementIndex) => {
                const result = validateMeasurement(rawMeasurements[measurementIndex]);
                return result.valid ? result.value : null;
            }
        );
        calculateSample(sample);
        return sample;
    }

    function normalizeMaterial(rawMaterial, index) {
        const parsedNumber = Number.parseInt(rawMaterial?.materialNumber, 10);
        const materialNumber = Number.isInteger(parsedNumber) && parsedNumber > 0
            ? parsedNumber
            : index + 1;
        const rawName = typeof rawMaterial?.name === 'string'
            ? rawMaterial.name.replace(/\s+/g, ' ').trim().slice(0, 50)
            : '';

        return {
            id: typeof rawMaterial?.id === 'string' && rawMaterial.id
                ? rawMaterial.id
                : createId(),
            materialNumber,
            name: rawName || `자재 ${materialNumber}`,
            samples: Array.from(
                { length: TOTAL_SAMPLES },
                (_, sampleIndex) => normalizeSample(rawMaterial?.samples?.[sampleIndex], sampleIndex)
            )
        };
    }

    function normalizeStoredPayload(payload) {
        if (!payload || !Array.isArray(payload.materials) || payload.materials.length === 0) {
            return null;
        }

        const normalizedMaterials = payload.materials
            .slice(0, 200)
            .map((material, index) => normalizeMaterial(material, index));

        if (normalizedMaterials.length === 0) {
            return null;
        }

        const materialIndex = clamp(
            Number.isInteger(Number(payload.state?.currentMaterial))
                ? Number(payload.state.currentMaterial)
                : 0,
            0,
            normalizedMaterials.length - 1
        );
        const sampleIndex = clamp(
            Number.isInteger(Number(payload.state?.currentSample))
                ? Number(payload.state.currentSample)
                : 0,
            0,
            TOTAL_SAMPLES - 1
        );

        return {
            materials: normalizedMaterials,
            currentMaterial: materialIndex,
            currentSample: sampleIndex
        };
    }

    function setSaveStatus(state, text) {
        if (!dom.saveStatus || !dom.saveStatusText) {
            return;
        }
        dom.saveStatus.dataset.state = state;
        dom.saveStatusText.textContent = text;
    }

    function saveData(message = '자동 저장됨') {
        const payload = {
            version: DATA_VERSION,
            updatedAt: new Date().toISOString(),
            materials,
            state: { currentMaterial, currentSample }
        };

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
            const time = new Intl.DateTimeFormat('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }).format(new Date());
            setSaveStatus('saved', `${message} · ${time}`);
            return true;
        } catch (error) {
            console.error('데이터 저장 실패:', error);
            setSaveStatus('error', '저장 실패 · JSON 백업을 권장합니다');
            showToast('브라우저 저장 공간이 부족하거나 사용할 수 없습니다.', 'error');
            return false;
        }
    }

    function loadData() {
        let stored = null;
        let sourceKey = null;

        try {
            stored = localStorage.getItem(STORAGE_KEY);
            sourceKey = stored ? STORAGE_KEY : null;
            if (!stored) {
                stored = localStorage.getItem(LEGACY_STORAGE_KEY);
                sourceKey = stored ? LEGACY_STORAGE_KEY : null;
            }
        } catch (error) {
            console.error('저장 데이터 접근 실패:', error);
            return { loaded: false, migrated: false };
        }

        if (!stored) {
            return { loaded: false, migrated: false };
        }

        try {
            const normalized = normalizeStoredPayload(JSON.parse(stored));
            if (!normalized) {
                throw new Error('지원되지 않는 데이터 구조입니다.');
            }
            materials = normalized.materials;
            currentMaterial = normalized.currentMaterial;
            currentSample = normalized.currentSample;
            return { loaded: true, migrated: sourceKey === LEGACY_STORAGE_KEY };
        } catch (error) {
            console.error('저장 데이터 복원 실패:', error);
            showToast('저장 데이터가 손상되어 새 데이터로 시작합니다.', 'error');
            return { loaded: false, migrated: false };
        }
    }

    function initializeData() {
        const loadResult = loadData();
        if (!loadResult.loaded) {
            materials = [createMaterialData(1)];
            currentMaterial = 0;
            currentSample = 0;
        }
        return loadResult;
    }

    function getCurrentMaterial() {
        return materials[currentMaterial];
    }

    function getCurrentSample() {
        return getCurrentMaterial().samples[currentSample];
    }

    function getNextMaterialNumber() {
        return materials.reduce((max, material) => {
            const number = Number.parseInt(material.materialNumber, 10);
            return Number.isInteger(number) ? Math.max(max, number) : max;
        }, 0) + 1;
    }

    function formatMeasurement(value) {
        return typeof value === 'number' && Number.isFinite(value)
            ? value.toFixed(1)
            : '-';
    }

    function showToast(message, type = 'info') {
        if (!dom.toast) {
            return;
        }
        window.clearTimeout(toastTimer);
        dom.toast.textContent = message;
        dom.toast.dataset.type = type;
        dom.toast.hidden = false;
        requestAnimationFrame(() => dom.toast.classList.add('show'));
        toastTimer = window.setTimeout(() => {
            dom.toast.classList.remove('show');
            window.setTimeout(() => {
                dom.toast.hidden = true;
            }, 180);
        }, 3200);
    }

    function createMaterialIconButton(className, label, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `material-row-icon ${className}`;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', onClick);
        return button;
    }

    function createMaterialRow(material, index) {
        const row = document.createElement('li');
        row.className = 'material-row';

        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.className = 'material-row-select';
        selectButton.textContent = material.name;
        selectButton.addEventListener('click', () => {
            closeMaterialPanel();
            selectMaterial(index);
        });

        if (index === currentMaterial) {
            row.classList.add('current');
            selectButton.setAttribute('aria-current', 'true');
        }

        const editButton = createMaterialIconButton(
            'edit',
            `${material.name} 이름 변경`,
            () => startMaterialEdit(index)
        );
        const pencil = document.createElement('span');
        pencil.className = 'icon-pencil';
        pencil.setAttribute('aria-hidden', 'true');
        editButton.appendChild(pencil);

        row.append(selectButton, editButton);
        return row;
    }

    function createMaterialEditRow(material, index) {
        const row = document.createElement('li');
        row.className = 'material-row editing';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'material-name-input';
        input.value = material.name;
        input.maxLength = 50;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', '자재 이름');
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveMaterialName(index, input.value);
            }
        });

        const saveButton = createMaterialIconButton(
            'save',
            '이름 저장',
            () => saveMaterialName(index, input.value)
        );
        saveButton.textContent = '✓';

        const cancelButton = createMaterialIconButton('cancel', '이름 변경 취소', cancelMaterialEdit);
        cancelButton.textContent = '×';

        const deleteButton = createMaterialIconButton(
            'delete',
            `${material.name} 삭제`,
            () => openDeleteMaterialModal(index)
        );
        const trash = document.createElement('span');
        trash.className = 'icon-trash';
        trash.setAttribute('aria-hidden', 'true');
        deleteButton.appendChild(trash);

        row.append(input, saveButton, cancelButton, deleteButton);
        return row;
    }

    function renderMaterialSelector() {
        dom.materialTrigger.textContent = getCurrentMaterial().name;
        dom.materialList.replaceChildren(
            ...materials.map((material, index) => (
                index === editingMaterialIndex
                    ? createMaterialEditRow(material, index)
                    : createMaterialRow(material, index)
            ))
        );
    }

    function openMaterialPanel() {
        editingMaterialIndex = null;
        renderMaterialSelector();
        dom.materialPanel.hidden = false;
        dom.materialTrigger.setAttribute('aria-expanded', 'true');
        dom.materialList.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
    }

    function closeMaterialPanel() {
        const wasEditing = editingMaterialIndex !== null;
        editingMaterialIndex = null;
        dom.materialPanel.hidden = true;
        dom.materialTrigger.setAttribute('aria-expanded', 'false');
        if (wasEditing) {
            renderMaterialSelector();
        }
    }

    function startMaterialEdit(index) {
        editingMaterialIndex = index;
        renderMaterialSelector();
        const input = dom.materialList.querySelector('.material-name-input');
        input.focus();
        input.select();
        input.scrollIntoView({ block: 'nearest' });
    }

    function cancelMaterialEdit() {
        editingMaterialIndex = null;
        renderMaterialSelector();
    }

    function saveMaterialName(index, enteredName) {
        const normalizedName = enteredName.replace(/\s+/g, ' ').trim().slice(0, 50);
        if (!normalizedName) {
            showToast('자재 이름을 한 글자 이상 입력해주세요.', 'error');
            return;
        }

        materials[index].name = normalizedName;
        editingMaterialIndex = null;
        renderMaterialSelector();
        saveData('자재 이름 저장됨');
    }

    function handleMaterialPanelKeydown(event) {
        if (event.key !== 'Escape' || dom.materialPanel.hidden) {
            return;
        }
        if (editingMaterialIndex !== null) {
            cancelMaterialEdit();
        } else {
            closeMaterialPanel();
            dom.materialTrigger.focus();
        }
    }

    function renderSampleSelector() {
        dom.sampleSelector.replaceChildren();
        const samples = getCurrentMaterial().samples;

        samples.forEach((sample, index) => {
            const option = document.createElement('option');
            const filledCount = sample.measurements.filter(value => value !== null).length;
            const status = filledCount === MEASUREMENTS_PER_SAMPLE
                ? '✓'
                : `${filledCount}/${MEASUREMENTS_PER_SAMPLE}`;
            option.value = String(index);
            option.textContent = `시료 ${index + 1} · ${status}`;
            dom.sampleSelector.appendChild(option);
        });

        dom.sampleSelector.value = String(currentSample);
    }

    function renderDataGrid() {
        dom.dataGrid.replaceChildren();
        const sample = getCurrentSample();

        sample.measurements.forEach((measurement, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'data-input-wrapper';

            const label = document.createElement('label');
            label.htmlFor = `measurement-${index}`;
            label.textContent = String(index + 1).padStart(2, '0');

            const input = document.createElement('input');
            input.type = 'number';
            input.id = `measurement-${index}`;
            input.className = 'data-input';
            input.inputMode = 'decimal';
            input.min = String(MIN_MEASUREMENT);
            input.max = String(MAX_MEASUREMENT);
            input.step = '0.1';
            input.autocomplete = 'off';
            input.setAttribute(
                'aria-label',
                `시료 ${currentSample + 1}의 ${index + 1}번째 측정값`
            );

            if (measurement !== null) {
                input.value = String(measurement);
                input.classList.add('filled');
            }

            input.addEventListener('input', event => handleInput(index, event.target.value));
            input.addEventListener('change', event => finalizeInput(index, event.target));
            input.addEventListener('keydown', event => handleKeydown(index, event));
            input.addEventListener('focus', () => highlightCurrentInput(index));

            wrapper.append(label, input);
            dom.dataGrid.appendChild(wrapper);
        });

        highlightNextEmpty(true);
    }

    function renderResults() {
        const sample = getCurrentSample();
        calculateSample(sample);
        dom.minValue.textContent = formatMeasurement(sample.min);
        dom.avgValue.textContent = formatMeasurement(sample.avg);
    }

    function renderProgress() {
        const filledCount = getCurrentSample().measurements.filter(value => value !== null).length;
        const percent = Math.round((filledCount / MEASUREMENTS_PER_SAMPLE) * 100);
        dom.progressIndicator.textContent = `${filledCount} / ${MEASUREMENTS_PER_SAMPLE}`;
        dom.progressBar.style.width = `${percent}%`;
        dom.progressTrack.setAttribute('aria-valuenow', String(filledCount));
        renderVoiceProgress(filledCount, percent);
    }

    function renderVoiceProgress(filledCount, percent) {
        if (!dom.voiceProgressIndicator || !dom.voiceProgressBar || !dom.voiceProgressTrack) {
            return;
        }
        dom.voiceProgressIndicator.textContent = `${filledCount} / ${MEASUREMENTS_PER_SAMPLE}`;
        dom.voiceProgressBar.style.width = `${percent}%`;
        dom.voiceProgressTrack.setAttribute('aria-valuenow', String(filledCount));
    }

    function renderSummaryTable() {
        dom.summaryTableBody.replaceChildren();

        getCurrentMaterial().samples.forEach((sample, index) => {
            calculateSample(sample);
            const filledCount = sample.measurements.filter(value => value !== null).length;
            const row = document.createElement('tr');
            if (index === currentSample) {
                row.classList.add('current-row');
            }

            const sampleCell = document.createElement('td');
            sampleCell.textContent = `#${index + 1}`;

            const countCell = document.createElement('td');
            countCell.textContent = `${filledCount}/${MEASUREMENTS_PER_SAMPLE}`;
            countCell.classList.toggle('completed-count', filledCount === MEASUREMENTS_PER_SAMPLE);

            const minCell = document.createElement('td');
            minCell.textContent = formatMeasurement(sample.min);

            const avgCell = document.createElement('td');
            avgCell.textContent = formatMeasurement(sample.avg);

            row.append(sampleCell, countCell, minCell, avgCell);
            dom.summaryTableBody.appendChild(row);
        });
    }

    function updateCurrentTitle() {
        dom.currentSampleTitle.textContent = `시료 ${currentSample + 1} 측정값 (μm)`;
    }

    function renderAll() {
        renderMaterialSelector();
        renderSampleSelector();
        renderDataGrid();
        renderResults();
        renderProgress();
        renderSummaryTable();
        updateCurrentTitle();
    }

    function addMaterial() {
        const materialNumber = getNextMaterialNumber();
        materials.push(createMaterialData(materialNumber));
        currentMaterial = materials.length - 1;
        currentSample = 0;
        voiceCursorIndex = null;
        renderAll();
        saveData('새 자재 저장됨');
        showToast(`자재 ${materialNumber}이 추가되었습니다.`, 'success');
    }

    function selectMaterial(index) {
        if (!materials[index] || index === currentMaterial) {
            return;
        }
        currentMaterial = index;
        currentSample = 0;
        voiceCursorIndex = null;
        voiceHistory = [];
        renderAll();
        saveData('선택 위치 저장됨');
    }

    function openDeleteMaterialModal(index) {
        const material = materials[index];
        if (!material) {
            return;
        }

        const measurementCount = material.samples.reduce(
            (count, sample) => count + sample.measurements.filter(value => value !== null).length,
            0
        );
        const dataText = measurementCount > 0
            ? `입력된 측정값 ${measurementCount}개가 함께 삭제되며 되돌릴 수 없습니다.`
            : '입력된 측정값은 없습니다. 삭제하면 되돌릴 수 없습니다.';

        pendingDeleteMaterialIndex = index;
        dom.deleteMaterialTitle.textContent = `"${material.name}" 자재를 삭제할까요?`;
        dom.deleteMaterialMessage.textContent = materials.length === 1
            ? `자재가 1개뿐이라 삭제 후 빈 "자재 1"로 초기화됩니다. ${dataText}`
            : dataText;

        closeMaterialPanel();
        dom.materialTrigger.focus();
        openModal(dom.deleteMaterialModal, dom.cancelDeleteMaterialBtn);
    }

    function closeDeleteMaterialModal() {
        pendingDeleteMaterialIndex = null;
        closeModal(dom.deleteMaterialModal);
    }

    function confirmDeleteMaterial() {
        const index = pendingDeleteMaterialIndex;
        closeDeleteMaterialModal();
        if (index !== null) {
            deleteMaterial(index);
        }
    }

    function deleteMaterial(index) {
        const material = materials[index];
        if (!material) {
            return;
        }

        if (materials.length === 1) {
            materials = [createMaterialData(1)];
            currentMaterial = 0;
            currentSample = 0;
            showToast('마지막 자재를 비우고 새 자재로 초기화했습니다.', 'info');
        } else {
            materials.splice(index, 1);
            if (index < currentMaterial) {
                currentMaterial -= 1;
            } else if (index === currentMaterial) {
                currentMaterial = Math.min(index, materials.length - 1);
                currentSample = 0;
            }
            showToast('자재가 삭제되었습니다.', 'success');
        }

        voiceCursorIndex = null;
        voiceHistory = [];
        renderAll();
        saveData('삭제 내용 저장됨');
    }

    function selectSample(index) {
        if (index < 0 || index >= TOTAL_SAMPLES) {
            return;
        }
        currentSample = index;
        voiceCursorIndex = null;
        voiceHistory = [];
        renderSampleSelector();
        renderDataGrid();
        renderResults();
        renderProgress();
        renderSummaryTable();
        updateCurrentTitle();
        saveData('선택 위치 저장됨');
    }

    function clearCurrentSample() {
        if (!window.confirm('현재 시료의 20개 측정값을 모두 지우시겠습니까?')) {
            return;
        }
        const sample = getCurrentSample();
        sample.measurements.fill(null);
        calculateSample(sample);
        voiceCursorIndex = null;
        voiceHistory = [];
        renderSampleSelector();
        renderDataGrid();
        renderResults();
        renderProgress();
        renderSummaryTable();
        saveData('시료 초기화 저장됨');
        showToast('현재 시료가 초기화되었습니다.', 'success');
    }

    function goToNextSample() {
        const filledCount = getCurrentSample().measurements.filter(value => value !== null).length;
        if (filledCount < MEASUREMENTS_PER_SAMPLE) {
            const remaining = MEASUREMENTS_PER_SAMPLE - filledCount;
            const proceed = window.confirm(
                `현재 시료에 ${filledCount}/${MEASUREMENTS_PER_SAMPLE}개가 입력되었습니다.\n` +
                `${remaining}개가 비어 있습니다. 그래도 다음 시료로 이동하시겠습니까?`
            );
            if (!proceed) {
                return false;
            }
        }

        if (currentSample >= TOTAL_SAMPLES - 1) {
            showToast('마지막 시료입니다.', 'info');
            return false;
        }

        selectSample(currentSample + 1);
        return true;
    }

    function handleInput(index, rawValue) {
        const input = document.getElementById(`measurement-${index}`);
        const result = validateMeasurement(rawValue);

        input.classList.toggle('invalid', !result.valid);
        input.classList.toggle('filled', result.valid && result.value !== null);
        input.setAttribute('aria-invalid', String(!result.valid));
        input.setCustomValidity(result.message);

        getCurrentSample().measurements[index] = result.valid ? result.value : null;
        renderResults();
        renderProgress();
        renderSampleSelector();
        renderSummaryTable();
        saveData();
    }

    function finalizeInput(index, input) {
        const result = validateMeasurement(input.value);
        if (!result.valid) {
            showToast(result.message, 'error');
            input.value = '';
            input.classList.remove('invalid', 'filled');
            input.setAttribute('aria-invalid', 'false');
            input.setCustomValidity('');
            getCurrentSample().measurements[index] = null;
            renderResults();
            renderProgress();
            renderSampleSelector();
            renderSummaryTable();
            saveData();
        }
    }

    function handleKeydown(index, event) {
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();

        const currentInput = event.currentTarget;
        if (currentInput.getAttribute('aria-invalid') === 'true') {
            finalizeInput(index, currentInput);
            return;
        }

        const nextInput = document.getElementById(`measurement-${index + 1}`);
        if (nextInput) {
            nextInput.focus();
            nextInput.select();
        } else {
            currentInput.blur();
            showToast('현재 시료의 마지막 입력칸입니다.', 'info');
        }
    }

    function clearCurrentHighlights() {
        document.querySelectorAll('.data-input.current').forEach(input => {
            input.classList.remove('current');
        });
    }

    function highlightCurrentInput(index) {
        clearCurrentHighlights();
        const input = document.getElementById(`measurement-${index}`);
        if (input) {
            input.classList.add('current');
            voiceCursorIndex = index;
        }
    }

    function findNextEmptyIndex(startIndex = 0) {
        const measurements = getCurrentSample().measurements;
        for (let offset = 0; offset < MEASUREMENTS_PER_SAMPLE; offset += 1) {
            const index = (startIndex + offset) % MEASUREMENTS_PER_SAMPLE;
            if (measurements[index] === null) {
                return index;
            }
        }
        return -1;
    }

    function highlightNextEmpty(skipFocus = false, startIndex = 0) {
        clearCurrentHighlights();
        const index = findNextEmptyIndex(startIndex);
        voiceCursorIndex = index;

        if (index < 0) {
            return -1;
        }

        const input = document.getElementById(`measurement-${index}`);
        if (input) {
            input.classList.add('current');
            if (!skipFocus) {
                input.focus();
            }
        }
        return index;
    }

    function escapeCsvCell(value) {
        let text = value === null || value === undefined ? '' : String(value);
        if (/^[\s]*[=+\-@]/.test(text)) {
            text = `'${text}`;
        }
        if (/[",\r\n]/.test(text)) {
            text = `"${text.replace(/"/g, '""')}"`;
        }
        return text;
    }

    function sanitizeFilename(value) {
        return String(value)
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
            .replace(/\s+/g, '_')
            .slice(0, 80) || '자재';
    }

    function getDateString() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function downloadBlob(content, type, filename) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function getMeasurementHeaders(includeMaterial = false) {
        const headers = [];
        if (includeMaterial) {
            headers.push('자재');
        }
        headers.push('시료번호');
        for (let index = 1; index <= MEASUREMENTS_PER_SAMPLE; index += 1) {
            headers.push(`측정${index}`);
        }
        headers.push('최솟값', '평균값');
        return headers;
    }

    function materialRows(material, includeMaterial = false) {
        return material.samples.map((sample, index) => {
            calculateSample(sample);
            const row = [];
            if (includeMaterial) {
                row.push(material.name);
            }
            row.push(index + 1, ...sample.measurements, sample.min, sample.avg);
            return row.map(escapeCsvCell).join(',');
        });
    }

    function exportCurrentMaterial() {
        const material = getCurrentMaterial();
        const rows = [
            getMeasurementHeaders(false).map(escapeCsvCell).join(','),
            ...materialRows(material, false)
        ];
        const filename = `아연도금두께_${sanitizeFilename(material.name)}_${getDateString()}.csv`;
        downloadBlob(`\ufeff${rows.join('\r\n')}`, 'text/csv;charset=utf-8', filename);
        showToast('현재 자재 CSV를 저장했습니다.', 'success');
    }

    function exportAllMaterials() {
        const rows = [
            getMeasurementHeaders(true).map(escapeCsvCell).join(','),
            ...materials.flatMap(material => materialRows(material, true))
        ];
        downloadBlob(
            `\ufeff${rows.join('\r\n')}`,
            'text/csv;charset=utf-8',
            `아연도금두께_전체자재_${getDateString()}.csv`
        );
        showToast('전체 자재 CSV를 저장했습니다.', 'success');
    }

    function exportBackup() {
        const backup = {
            app: '아연도금 두께 측정',
            version: DATA_VERSION,
            exportedAt: new Date().toISOString(),
            materials,
            state: { currentMaterial, currentSample }
        };
        downloadBlob(
            JSON.stringify(backup, null, 2),
            'application/json;charset=utf-8',
            `아연도금두께_백업_${getDateString()}.json`
        );
        showToast('전체 데이터 JSON 백업을 저장했습니다.', 'success');
    }

    async function importBackup(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) {
            return;
        }

        try {
            const payload = JSON.parse(await file.text());
            const normalized = normalizeStoredPayload(payload);
            if (!normalized) {
                throw new Error('올바른 백업 데이터가 아닙니다.');
            }

            const confirmed = window.confirm(
                `백업에 자재 ${normalized.materials.length}개가 있습니다.\n` +
                '현재 데이터를 백업 내용으로 교체하시겠습니까?'
            );
            if (!confirmed) {
                return;
            }

            stopVoiceInput();
            materials = normalized.materials;
            currentMaterial = normalized.currentMaterial;
            currentSample = normalized.currentSample;
            voiceCursorIndex = null;
            voiceHistory = [];
            renderAll();
            saveData('백업 복원 저장됨');
            showToast('백업 데이터를 복원했습니다.', 'success');
        } catch (error) {
            console.error('백업 복원 실패:', error);
            showToast('백업 파일을 읽을 수 없습니다.', 'error');
        }
    }

    const SINO_DIGITS = new Map([
        ['영', 0], ['공', 0], ['일', 1], ['이', 2], ['삼', 3],
        ['사', 4], ['오', 5], ['육', 6], ['칠', 7], ['팔', 8], ['구', 9]
    ]);
    const NATIVE_DIGITS = new Map([
        ['아홉', 9], ['여덟', 8], ['일곱', 7], ['여섯', 6], ['다섯', 5],
        ['하나', 1], ['한', 1], ['둘', 2], ['두', 2], ['셋', 3], ['세', 3], ['넷', 4], ['네', 4]
    ]);
    const NATIVE_TENS = new Map([
        ['아흔', 90], ['여든', 80], ['일흔', 70], ['예순', 60], ['쉰', 50],
        ['마흔', 40], ['서른', 30], ['스물', 20], ['열', 10]
    ]);
    const SMALL_UNITS = new Map([['천', 1000], ['백', 100], ['십', 10]]);
    const SEPARATOR_WORDS = ['그다음', '다음값', '그리고', '다음'];
    const NUMBER_WORDS = [
        ...SINO_DIGITS.keys(),
        ...NATIVE_DIGITS.keys(),
        ...NATIVE_TENS.keys(),
        ...SMALL_UNITS.keys(),
        ...SEPARATOR_WORDS,
        '점'
    ].sort((a, b) => b.length - a.length);

    function tokenizeMeasurementText(text) {
        const tokens = [];
        let index = 0;

        while (index < text.length) {
            const rest = text.slice(index);

            const space = rest.match(/^\s+/);
            if (space) {
                index += space[0].length;
                continue;
            }
            if (rest[0] === ',' || rest[0] === '/') {
                tokens.push({ type: 'separator' });
                index += 1;
                continue;
            }

            const arabic = rest.match(/^\d+(?:\.\d+)?/);
            if (arabic) {
                tokens.push({ type: 'arabic', text: arabic[0] });
                index += arabic[0].length;
                continue;
            }

            const word = NUMBER_WORDS.find(candidate => rest.startsWith(candidate));
            if (!word) {
                return null;
            }

            if (SINO_DIGITS.has(word)) {
                tokens.push({ type: 'digit', value: SINO_DIGITS.get(word) });
            } else if (NATIVE_DIGITS.has(word)) {
                tokens.push({ type: 'nativeDigit', value: NATIVE_DIGITS.get(word) });
            } else if (NATIVE_TENS.has(word)) {
                tokens.push({ type: 'nativeTen', value: NATIVE_TENS.get(word) });
            } else if (SMALL_UNITS.has(word)) {
                tokens.push({ type: 'unit', value: SMALL_UNITS.get(word) });
            } else if (word === '점') {
                tokens.push({ type: 'point' });
            } else {
                tokens.push({ type: 'separator' });
            }
            index += word.length;
        }

        return tokens;
    }

    function readIntegerPart(tokens, start) {
        const first = tokens[start];

        if (first.type === 'nativeTen') {
            const next = tokens[start + 1];
            return next?.type === 'nativeDigit'
                ? { value: first.value + next.value, next: start + 2 }
                : { value: first.value, next: start + 1 };
        }

        // "팔 육"처럼 자리 단위 없이 숫자만 읽은 경우
        let runEnd = start;
        while (tokens[runEnd]?.type === 'digit' && tokens[runEnd + 1]?.type !== 'unit') {
            runEnd += 1;
        }
        if (runEnd - start >= 2) {
            const digits = tokens.slice(start, runEnd).map(token => token.value).join('');
            return { value: Number(digits), next: runEnd };
        }
        if (runEnd - start === 1) {
            // "네", "이" 같은 짧은 말이 값으로 저장되지 않도록 소수점이 있을 때만 허용합니다.
            return tokens[runEnd]?.type === 'point'
                ? { value: first.value, next: runEnd }
                : null;
        }

        let value = 0;
        let lastUnit = Infinity;
        let index = start;

        if (first.type === 'arabic') {
            value = Number(first.text);
            const zeros = first.text.match(/0*$/)[0].length;
            lastUnit = value === 0 ? 1 : 10 ** zeros;
            index += 1;
        }

        while (index < tokens.length) {
            const token = tokens[index];
            const next = tokens[index + 1];

            if (token.type === 'unit' && token.value < lastUnit) {
                value += token.value;
                lastUnit = token.value;
                index += 1;
            } else if (
                token.type === 'digit' && next?.type === 'unit' &&
                token.value > 0 && next.value < lastUnit
            ) {
                value += token.value * next.value;
                lastUnit = next.value;
                index += 2;
            } else {
                if (
                    token.type === 'digit' && next?.type !== 'unit' &&
                    token.value > 0 && lastUnit > 1 && index > start
                ) {
                    value += token.value;
                    index += 1;
                }
                break;
            }
        }

        return index > start ? { value, next: index } : null;
    }

    function readNumber(tokens, start) {
        const first = tokens[start];
        if (first.type === 'arabic' && first.text.includes('.')) {
            return { value: Number(first.text), next: start + 1 };
        }

        const integerPart = readIntegerPart(tokens, start);
        if (!integerPart) {
            return null;
        }
        if (tokens[integerPart.next]?.type !== 'point') {
            return integerPart;
        }

        let index = integerPart.next + 1;
        let decimals = '';
        if (tokens[index]?.type === 'arabic' && !tokens[index].text.includes('.')) {
            decimals = tokens[index].text;
            index += 1;
        } else {
            // 뒤에 단위나 "점"이 붙은 숫자는 다음 값의 시작입니다.
            while (
                tokens[index]?.type === 'digit' &&
                tokens[index + 1]?.type !== 'unit' &&
                tokens[index + 1]?.type !== 'point'
            ) {
                decimals += String(tokens[index].value);
                index += 1;
            }
        }

        return decimals
            ? { value: Number(`${integerPart.value}.${decimals}`), next: index }
            : null;
    }

    function extractMeasurementNumbers(transcript) {
        const normalized = String(transcript)
            .replace(/마이크로\s*미터|마이크론|미크론|마이크로|㎛|μm|µm/gi, '')
            .replace(/측정값|측정|입력값|입력|값은|값/g, '')
            .replace(/빽/g, '백')
            .replace(/쩜/g, '점')
            .replace(/[.!?。\s]+$/, '')
            .replace(/(\d)\s*(?:이요|이에요)$/, '$1');

        // "팔십이요"는 80인지 82인지 알 수 없으므로 저장하지 않습니다.
        if (/[가-힣]이(?:요|에요)$/.test(normalized)) {
            return [];
        }

        const tokens = tokenizeMeasurementText(
            normalized.replace(/\s*(?:입니다|예요|에요|요)$/, '')
        );
        if (!tokens) {
            return [];
        }

        // 일부라도 해석하지 못하면 순서가 어긋나지 않도록 문장 전체를 버립니다.
        const values = [];
        let index = 0;
        while (index < tokens.length) {
            if (tokens[index].type === 'separator') {
                index += 1;
                continue;
            }
            const parsed = readNumber(tokens, index);
            if (!parsed || !Number.isFinite(parsed.value)) {
                return [];
            }
            values.push(parsed.value);
            index = parsed.next;
        }
        return values;
    }

    function isValidVoiceRange(range) {
        return Number.isFinite(range?.min) && Number.isFinite(range?.max) &&
            range.min >= MIN_MEASUREMENT && range.max <= MAX_MEASUREMENT &&
            range.min < range.max;
    }

    function loadVoiceRange() {
        try {
            const stored = JSON.parse(localStorage.getItem(VOICE_RANGE_KEY));
            if (isValidVoiceRange(stored)) {
                voiceRange = { min: stored.min, max: stored.max };
            }
        } catch (error) {
            console.warn('음성 허용 범위를 읽지 못했습니다.', error);
        }
    }

    function renderVoiceRange() {
        dom.voiceRangeMin.value = String(voiceRange.min);
        dom.voiceRangeMax.value = String(voiceRange.max);
    }

    function updateVoiceRange() {
        const minText = dom.voiceRangeMin.value.trim();
        const maxText = dom.voiceRangeMax.value.trim();
        const range = { min: Number(minText), max: Number(maxText) };

        if (!minText || !maxText || !isValidVoiceRange(range)) {
            renderVoiceRange();
            showToast('허용 범위는 최소가 최대보다 작아야 합니다.', 'error');
            return;
        }

        voiceRange = range;
        try {
            localStorage.setItem(VOICE_RANGE_KEY, JSON.stringify(range));
        } catch (error) {
            console.warn('음성 허용 범위를 저장하지 못했습니다.', error);
        }
        showToast(`음성 허용 범위: ${range.min} ~ ${range.max} μm`, 'success');
    }

    function isCurrentSampleFull() {
        return findNextEmptyIndex(0) < 0;
    }

    function getSampleFullGuide() {
        const nextAction = currentSample >= TOTAL_SAMPLES - 1 ? '입력 완료' : '다음 시료';
        return `20개 입력 완료 · "다음" ${nextAction}, "다시" 마지막 값 취소`;
    }

    function getListeningMessage() {
        return isCurrentSampleFull()
            ? getSampleFullGuide()
            : '듣고 있습니다. 측정값을 말씀해주세요.';
    }

    function setVoiceStatus(message, state = voiceState) {
        dom.voiceStatus.textContent = message;
        dom.voiceModal.dataset.state = state;
    }

    function updateVoiceVisual(listening, talking = false) {
        dom.voiceVisualization.classList.toggle('listening', listening);
        dom.voiceVisualization.classList.toggle('talking', talking);
        dom.voiceVisualization.textContent = listening ? '🎙️' : '🎤';
    }

    function prepareAudioContext() {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            return;
        }
        try {
            audioContext ??= new AudioContextCtor();
            if (audioContext.state === 'suspended') {
                audioContext.resume().catch(() => {});
            }
        } catch (error) {
            console.warn('오디오 피드백을 시작할 수 없습니다.', error);
        }
    }

    function playFeedback(type) {
        if (navigator.vibrate) {
            navigator.vibrate(type === 'undo' ? [40, 30, 40] : 45);
        }
        if (!audioContext || audioContext.state !== 'running') {
            return;
        }

        try {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            oscillator.connect(gain);
            gain.connect(audioContext.destination);

            const startFrequency = type === 'undo' ? 440 : 740;
            const endFrequency = type === 'undo' ? 250 : 980;
            const duration = type === 'undo' ? 0.16 : 0.09;
            oscillator.type = type === 'undo' ? 'triangle' : 'sine';
            oscillator.frequency.setValueAtTime(startFrequency, audioContext.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(
                endFrequency,
                audioContext.currentTime + duration
            );
            gain.gain.setValueAtTime(0.035, audioContext.currentTime);
            gain.gain.exponentialRampToValueAtTime(
                0.001,
                audioContext.currentTime + duration
            );
            oscillator.start();
            oscillator.stop(audioContext.currentTime + duration);
        } catch (error) {
            console.warn('오디오 피드백 재생 실패:', error);
        }
    }

    async function acquireWakeLock() {
        if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') {
            return;
        }
        try {
            const lock = await navigator.wakeLock.request('screen');
            if (!shouldBeListening) {
                lock.release().catch(() => {});
                return;
            }
            wakeLock = lock;
            lock.addEventListener('release', () => {
                if (wakeLock === lock) {
                    wakeLock = null;
                }
            });
        } catch (error) {
            console.warn('화면 꺼짐 방지를 사용할 수 없습니다.', error);
        }
    }

    function releaseWakeLock() {
        const lock = wakeLock;
        wakeLock = null;
        lock?.release().catch(() => {});
    }

    function handleVisibilityChange() {
        if (!shouldBeListening) {
            return;
        }
        if (document.visibilityState === 'hidden') {
            clearVoiceRetryTimer();
            invalidateRecognition();
            updateVoiceVisual(false);
        } else {
            voiceRetryCount = 0;
            acquireWakeLock();
            startRecognitionAttempt(true);
        }
    }

    function invalidateRecognition() {
        recognitionToken += 1;
        const activeRecognition = recognition;
        recognition = null;
        if (activeRecognition) {
            try {
                activeRecognition.abort();
            } catch {
                // 이미 종료된 인식 객체는 무시합니다.
            }
        }
    }

    function clearVoiceRetryTimer() {
        window.clearTimeout(voiceRetryTimer);
        voiceRetryTimer = null;
    }

    function scheduleVoiceRestart(reason) {
        if (!shouldBeListening || voiceRetryTimer) {
            return;
        }

        if (voiceRetryCount >= MAX_VOICE_RETRIES) {
            shouldBeListening = false;
            releaseWakeLock();
            voiceState = 'error';
            setVoiceStatus('음성 연결에 반복해서 실패했습니다. 잠시 후 다시 시작해주세요.', 'error');
            updateVoiceVisual(false);
            dom.restartVoiceBtn.hidden = false;
            return;
        }

        const delay = Math.min(600 * (2 ** voiceRetryCount), 8000);
        voiceRetryCount += 1;
        voiceState = 'retrying';
        setVoiceStatus(
            `${reason} ${Math.ceil(delay / 1000)}초 후 다시 연결합니다. (${voiceRetryCount}/${MAX_VOICE_RETRIES})`,
            'retrying'
        );
        updateVoiceVisual(false);

        voiceRetryTimer = window.setTimeout(() => {
            voiceRetryTimer = null;
            if (shouldBeListening) {
                startRecognitionAttempt();
            }
        }, delay);
    }

    function scheduleQuietRestart() {
        if (voiceRetryTimer) {
            return;
        }
        voiceRetryTimer = window.setTimeout(() => {
            voiceRetryTimer = null;
            if (shouldBeListening) {
                startRecognitionAttempt(true);
            }
        }, QUICK_RESTART_MS);
    }

    function createRecognition(quiet) {
        const instance = new SpeechRecognitionCtor();
        const token = ++recognitionToken;

        instance.lang = 'ko-KR';
        instance.continuous = true;
        instance.interimResults = true;
        instance.maxAlternatives = 1;

        const isCurrent = () => recognition === instance && recognitionToken === token;
        const startedAt = Date.now();
        let sessionFailed = false;
        const processedFinals = [];
        let lastFinalText = '';
        let lastFinalAt = 0;

        // 일부 Android는 앞서 확정한 문장을 다시 보내므로 새로 말한 부분만 남깁니다.
        const takeNewFinalText = text => {
            const now = Date.now();
            let newText = text;
            if (text === lastFinalText && now - lastFinalAt < DUPLICATE_FINAL_MS) {
                newText = '';
            } else if (lastFinalText && text.startsWith(`${lastFinalText} `)) {
                newText = text.slice(lastFinalText.length).trim();
            }
            lastFinalText = text;
            lastFinalAt = now;
            return newText;
        };

        instance.onstart = () => {
            if (!isCurrent()) {
                return;
            }
            voiceState = 'listening';
            if (!quiet) {
                setVoiceStatus(getListeningMessage(), 'listening');
            }
            updateVoiceVisual(true);
            dom.restartVoiceBtn.hidden = true;
        };

        instance.onresult = event => {
            if (!isCurrent()) {
                return;
            }

            voiceRetryCount = 0;
            let interimTranscript = '';
            const finalTranscripts = [];

            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const transcript = event.results[index][0].transcript.trim();
                if (event.results[index].isFinal) {
                    const isReplay = processedFinals[index] === transcript && (
                        index < event.results.length - 1 ||
                        Date.now() - lastFinalAt < DUPLICATE_FINAL_MS
                    );
                    if (!isReplay) {
                        processedFinals[index] = transcript;
                        const newText = takeNewFinalText(transcript);
                        if (newText) {
                            finalTranscripts.push(newText);
                        }
                    }
                } else {
                    interimTranscript += `${transcript} `;
                }
            }

            if (interimTranscript.trim()) {
                dom.voiceResult.textContent = `${interimTranscript.trim()}…`;
                dom.voiceResult.dataset.final = 'false';
            }

            if (finalTranscripts.length > 0) {
                const finalTranscript = finalTranscripts.join(' ');
                dom.voiceResult.textContent = finalTranscript;
                dom.voiceResult.dataset.final = 'true';
                processVoiceInput(finalTranscript);
            }
        };

        instance.onerror = event => {
            if (!isCurrent()) {
                return;
            }

            // 측정 중 침묵은 정상입니다. 세션이 끝나면 onend에서 바로 다시 듣습니다.
            if (event.error === 'no-speech') {
                return;
            }

            sessionFailed = true;
            voiceState = 'error';
            updateVoiceVisual(false);

            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                shouldBeListening = false;
                clearVoiceRetryTimer();
                releaseWakeLock();
                setVoiceStatus('마이크 권한이 차단되었습니다. 브라우저 설정에서 권한을 허용해주세요.', 'error');
                dom.restartVoiceBtn.hidden = false;
                return;
            }

            const errorMessages = {
                'no-speech': '음성이 감지되지 않았습니다.',
                network: '네트워크 연결을 확인해주세요.',
                'audio-capture': '사용 가능한 마이크를 찾을 수 없습니다.',
                'language-not-supported': '한국어 음성 인식을 지원하지 않습니다.'
            };
            const message = errorMessages[event.error] || '음성 인식 연결이 중단되었습니다.';
            scheduleVoiceRestart(message);
        };

        instance.onend = () => {
            if (!isCurrent()) {
                return;
            }
            recognition = null;
            if (!shouldBeListening || document.visibilityState === 'hidden') {
                updateVoiceVisual(false);
                return;
            }
            if (sessionFailed) {
                scheduleVoiceRestart('음성 연결이 종료되었습니다.');
            } else if (Date.now() - startedAt < HEALTHY_SESSION_MS) {
                updateVoiceVisual(false);
                scheduleVoiceRestart('음성 연결이 바로 종료되었습니다.');
            } else {
                voiceRetryCount = 0;
                scheduleQuietRestart();
            }
        };

        instance.onsoundstart = () => {
            if (isCurrent()) {
                updateVoiceVisual(true, true);
            }
        };
        instance.onsoundend = () => {
            if (isCurrent()) {
                updateVoiceVisual(true, false);
            }
        };

        return instance;
    }

    function startRecognitionAttempt(quiet = false) {
        if (!shouldBeListening || document.visibilityState === 'hidden') {
            return;
        }

        clearVoiceRetryTimer();
        invalidateRecognition();
        recognition = createRecognition(quiet);
        voiceState = 'connecting';
        if (!quiet) {
            setVoiceStatus('마이크에 연결하고 있습니다…', 'connecting');
        }

        try {
            recognition.start();
        } catch (error) {
            console.warn('음성 인식 시작 실패:', error);
            recognition = null;
            scheduleVoiceRestart('음성 인식을 시작하지 못했습니다.');
        }
    }

    function startVoiceInput() {
        if (!SpeechRecognitionCtor) {
            showToast('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용해주세요.', 'error');
            return;
        }
        if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            showToast('음성 인식은 HTTPS 보안 연결에서만 사용할 수 있습니다.', 'error');
            return;
        }

        prepareAudioContext();
        voiceHistory = [];
        voiceCursorIndex = findNextEmptyIndex(0);
        renderProgress();
        if (voiceCursorIndex < 0) {
            completeVoiceInput();
            return;
        }
        if (voiceCursorIndex >= 0) {
            highlightCurrentInput(voiceCursorIndex);
        } else {
            clearCurrentHighlights();
        }

        shouldBeListening = true;
        voiceRetryCount = 0;
        dom.voiceResult.textContent = '-';
        dom.voiceResult.dataset.final = 'false';
        dom.restartVoiceBtn.hidden = true;
        openModal(dom.voiceModal, dom.stopVoiceBtn);
        acquireWakeLock();
        startRecognitionAttempt();
    }

    function restartVoiceInput() {
        if (!SpeechRecognitionCtor) {
            return;
        }
        prepareAudioContext();
        shouldBeListening = true;
        voiceRetryCount = 0;
        dom.restartVoiceBtn.hidden = true;
        acquireWakeLock();
        startRecognitionAttempt();
    }

    function stopVoiceInput() {
        shouldBeListening = false;
        releaseWakeLock();
        voiceState = 'idle';
        clearVoiceRetryTimer();
        invalidateRecognition();
        updateVoiceVisual(false);
        if (dom.voiceModal && !dom.voiceModal.hidden) {
            closeModal(dom.voiceModal);
        }
    }

    function completeVoiceInput() {
        shouldBeListening = false;
        releaseWakeLock();
        voiceState = 'complete';
        clearVoiceRetryTimer();
        invalidateRecognition();
        updateVoiceVisual(false);
        clearCurrentHighlights();
        renderProgress();

        if (dom.voiceModal && !dom.voiceModal.hidden) {
            closeModal(dom.voiceModal);
        }

        const material = getCurrentMaterial();
        const isLastSample = currentSample >= TOTAL_SAMPLES - 1;
        dom.voiceCompleteTitle.textContent = isLastSample
            ? '모든 시료 입력 완료'
            : '20개 입력 완료';
        dom.voiceCompleteMessage.textContent = isLastSample
            ? `${material.name}의 마지막 시료까지 측정값 입력을 모두 완료했습니다.`
            : `${material.name} · 시료 ${currentSample + 1}의 측정값 20개를 모두 입력했습니다. 다음 시료로 넘어가겠습니까?`;
        dom.confirmVoiceCompleteBtn.textContent = isLastSample
            ? '확인'
            : '확인 · 다음 시료';
        dom.cancelVoiceCompleteBtn.hidden = isLastSample;
        openModal(dom.voiceCompleteModal, dom.confirmVoiceCompleteBtn);
    }

    function closeVoiceComplete() {
        closeModal(dom.voiceCompleteModal);
    }

    function confirmVoiceComplete() {
        if (currentSample >= TOTAL_SAMPLES - 1) {
            closeVoiceComplete();
            return;
        }

        closeVoiceComplete();
        currentSample += 1;
        voiceHistory = [];
        voiceCursorIndex = null;
        renderSampleSelector();
        renderDataGrid();
        renderResults();
        renderProgress();
        renderSummaryTable();
        updateCurrentTitle();
        saveData('다음 시료 선택 저장됨');
        startVoiceInput();
    }

    function moveToNextSampleByVoice() {
        const filledCount = getCurrentSample().measurements.filter(value => value !== null).length;
        if (filledCount < MEASUREMENTS_PER_SAMPLE) {
            setVoiceStatus(
                `아직 ${MEASUREMENTS_PER_SAMPLE - filledCount}개가 비어 있습니다. 모두 입력한 뒤 "다음"이라고 말해주세요.`,
                'warning'
            );
            playFeedback('undo');
            return;
        }
        if (currentSample >= TOTAL_SAMPLES - 1) {
            completeVoiceInput();
            return;
        }

        currentSample += 1;
        voiceHistory = [];
        voiceCursorIndex = null;
        renderSampleSelector();
        renderDataGrid();
        renderResults();
        renderProgress();
        renderSummaryTable();
        updateCurrentTitle();
        saveData('다음 시료 선택 저장됨');
        playFeedback('input');
        const nextEmptyIndex = findNextEmptyIndex(0);
        setVoiceStatus(
            nextEmptyIndex < 0
                ? `시료 ${currentSample + 1}은 이미 20개가 입력되어 있습니다. "다음"이라고 말해주세요.`
                : `시료 ${currentSample + 1}입니다. ${nextEmptyIndex + 1}번 측정값을 말씀해주세요.`,
            nextEmptyIndex < 0 ? 'complete' : 'listening'
        );
    }

    function inputVoiceNumber(number) {
        const validation = validateMeasurement(number);
        if (!validation.valid) {
            setVoiceStatus(validation.message, 'warning');
            return false;
        }

        const targetIndex = findNextEmptyIndex(
            voiceCursorIndex >= 0 ? voiceCursorIndex : 0
        );
        if (targetIndex < 0) {
            setVoiceStatus(getSampleFullGuide(), 'warning');
            return false;
        }

        const sample = getCurrentSample();
        const previousValue = sample.measurements[targetIndex];
        sample.measurements[targetIndex] = validation.value;
        voiceHistory.push({
            materialId: getCurrentMaterial().id,
            sampleIndex: currentSample,
            measurementIndex: targetIndex,
            previousValue,
            newValue: validation.value
        });

        const input = document.getElementById(`measurement-${targetIndex}`);
        input.value = String(validation.value);
        input.classList.remove('invalid');
        input.classList.add('filled');
        input.setAttribute('aria-invalid', 'false');

        calculateSample(sample);
        renderResults();
        renderProgress();
        renderSampleSelector();
        renderSummaryTable();
        saveData();
        playFeedback('input');

        const nextIndex = findNextEmptyIndex(targetIndex + 1);
        if (nextIndex >= 0) {
            voiceCursorIndex = nextIndex;
            highlightCurrentInput(nextIndex);
            setVoiceStatus(
                `${targetIndex + 1}번에 ${formatMeasurement(validation.value)} μm 입력됨 · 다음 값을 말씀해주세요.`,
                'listening'
            );
        } else {
            voiceCursorIndex = -1;
            clearCurrentHighlights();
            setVoiceStatus(
                `${targetIndex + 1}번에 ${formatMeasurement(validation.value)} μm 입력됨 · ${getSampleFullGuide()}`,
                'complete'
            );
        }
        return true;
    }

    function undoLastVoiceInput() {
        const materialId = getCurrentMaterial().id;
        let historyIndex = -1;

        for (let index = voiceHistory.length - 1; index >= 0; index -= 1) {
            const entry = voiceHistory[index];
            if (entry.materialId === materialId && entry.sampleIndex === currentSample) {
                historyIndex = index;
                break;
            }
        }

        if (historyIndex < 0) {
            setVoiceStatus('이번 음성 입력에서 취소할 값이 없습니다.', 'warning');
            return;
        }

        const [entry] = voiceHistory.splice(historyIndex, 1);
        const sample = getCurrentSample();
        sample.measurements[entry.measurementIndex] = entry.previousValue;
        const input = document.getElementById(`measurement-${entry.measurementIndex}`);
        input.value = entry.previousValue === null ? '' : String(entry.previousValue);
        input.classList.toggle('filled', entry.previousValue !== null);

        calculateSample(sample);
        voiceCursorIndex = entry.measurementIndex;
        highlightCurrentInput(entry.measurementIndex);
        renderResults();
        renderProgress();
        renderSampleSelector();
        renderSummaryTable();
        saveData('취소 내용 저장됨');
        playFeedback('undo');
        setVoiceStatus(
            `${entry.measurementIndex + 1}번의 ${formatMeasurement(entry.newValue)} μm 입력을 취소했습니다.`,
            'listening'
        );
    }

    function rejectVoiceInput(message) {
        setVoiceStatus(message, 'warning');
        playFeedback('undo');
    }

    function processVoiceInput(transcript) {
        const commandText = transcript.replace(/[\s.!?。]+/g, '');

        if (/^(?:입력|음성)?(?:종료|닫기)$|^그만(?:해)?$/.test(commandText)) {
            stopVoiceInput();
            return;
        }
        if (/^(?:마지막|방금|입력)?(?:다시|취소|되돌리기)$|^뒤로$/.test(commandText)) {
            undoLastVoiceInput();
            return;
        }
        if (/^다음(?:시료)?(?:로)?$|^넘어가(?:자|기)?$/.test(commandText)) {
            moveToNextSampleByVoice();
            return;
        }

        const numbers = extractMeasurementNumbers(transcript);
        if (numbers.length === 0) {
            rejectVoiceInput('숫자를 확인하지 못해 저장하지 않았습니다. 다시 말씀해주세요. 예: "팔십육 점 사"');
            return;
        }

        const outOfRange = numbers.find(
            number => number < voiceRange.min || number > voiceRange.max
        );
        if (outOfRange !== undefined) {
            rejectVoiceInput(
                `${outOfRange} μm는 허용 범위(${voiceRange.min}~${voiceRange.max})를 벗어나 저장하지 않았습니다. 다시 말씀해주세요.`
            );
            return;
        }

        const remaining = getCurrentSample().measurements.filter(value => value === null).length;
        if (remaining === 0) {
            rejectVoiceInput(getSampleFullGuide());
            return;
        }
        if (numbers.length > remaining) {
            rejectVoiceInput(
                `남은 칸은 ${remaining}개인데 ${numbers.length}개를 들었습니다. 저장하지 않았으니 다시 말씀해주세요.`
            );
            return;
        }

        let insertedCount = 0;
        for (const number of numbers) {
            if (!inputVoiceNumber(number)) {
                break;
            }
            insertedCount += 1;
        }

        if (numbers.length > 1 && insertedCount > 0 && !isCurrentSampleFull()) {
            setVoiceStatus(`${insertedCount}개 측정값을 순서대로 입력했습니다.`, 'listening');
        }
    }

    function openModal(modal, focusTarget) {
        previousFocus = document.activeElement;
        activeModal = modal;
        modal.hidden = false;
        document.body.classList.add('modal-open');
        window.setTimeout(() => focusTarget?.focus(), 0);
    }

    function closeModal(modal) {
        modal.hidden = true;
        if (activeModal === modal) {
            activeModal = null;
            document.body.classList.remove('modal-open');
            previousFocus?.focus?.();
            previousFocus = null;
        }
    }

    function openManual() {
        openModal(dom.manualModal, dom.closeManualBtn);
    }

    function closeManual() {
        closeModal(dom.manualModal);
    }

    function openMenu() {
        openModal(dom.menuModal, dom.closeMenuBtn);
    }

    function closeMenu() {
        closeModal(dom.menuModal);
    }

    function bindMenuAction(button, action) {
        button.addEventListener('click', () => {
            closeMenu();
            action();
        });
    }

    function handleModalKeydown(event) {
        if (!activeModal || activeModal.hidden) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            if (activeModal === dom.voiceModal) {
                stopVoiceInput();
            } else if (activeModal === dom.voiceCompleteModal) {
                closeVoiceComplete();
            } else if (activeModal === dom.menuModal) {
                closeMenu();
            } else if (activeModal === dom.deleteMaterialModal) {
                closeDeleteMaterialModal();
            } else {
                closeManual();
            }
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const focusable = Array.from(activeModal.querySelectorAll(
            'button:not([hidden]):not(:disabled), input:not([hidden]):not(:disabled), [tabindex]:not([tabindex="-1"])'
        )).filter(element => element.offsetParent !== null);

        if (focusable.length === 0) {
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function setupPwa() {
        window.addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            deferredInstallPrompt = event;
            dom.installBtn.hidden = false;
        });

        dom.installBtn.addEventListener('click', async () => {
            if (!deferredInstallPrompt) {
                return;
            }
            deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            dom.installBtn.hidden = true;
        });

        window.addEventListener('appinstalled', () => {
            deferredInstallPrompt = null;
            dom.installBtn.hidden = true;
            showToast('앱 설치가 완료되었습니다.', 'success');
        });

        if ('serviceWorker' in navigator) {
            window.addEventListener('load', async () => {
                try {
                    const registration = await navigator.serviceWorker.register('./sw.js');
                    registration.addEventListener('updatefound', () => {
                        const worker = registration.installing;
                        worker?.addEventListener('statechange', () => {
                            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                                showToast('새 버전을 준비했습니다. 다음 실행부터 적용됩니다.', 'info');
                            }
                        });
                    });
                } catch (error) {
                    console.warn('오프라인 기능 등록 실패:', error);
                }
            });
        }
    }

    function bindEvents() {
        dom.materialTrigger.addEventListener('click', () => {
            if (dom.materialPanel.hidden) {
                openMaterialPanel();
            } else {
                closeMaterialPanel();
            }
        });
        dom.addMaterialBtn.addEventListener('click', () => {
            closeMaterialPanel();
            addMaterial();
        });
        document.addEventListener('pointerdown', event => {
            if (!dom.materialPanel.hidden && !event.composedPath().includes(dom.materialPicker)) {
                closeMaterialPanel();
            }
        });
        document.addEventListener('keydown', handleMaterialPanelKeydown);
        dom.sampleSelector.addEventListener('change', event => selectSample(Number(event.target.value)));

        dom.menuBtn.addEventListener('click', openMenu);
        dom.closeMenuBtn.addEventListener('click', closeMenu);
        dom.menuModal.addEventListener('click', event => {
            if (event.target === dom.menuModal) {
                closeMenu();
            }
        });
        dom.cancelDeleteMaterialBtn.addEventListener('click', closeDeleteMaterialModal);
        dom.confirmDeleteMaterialBtn.addEventListener('click', confirmDeleteMaterial);
        dom.deleteMaterialModal.addEventListener('click', event => {
            if (event.target === dom.deleteMaterialModal) {
                closeDeleteMaterialModal();
            }
        });
        bindMenuAction(dom.manualBtn, openManual);
        bindMenuAction(dom.exportCurrentBtn, exportCurrentMaterial);
        bindMenuAction(dom.exportAllBtn, exportAllMaterials);
        bindMenuAction(dom.backupBtn, exportBackup);
        dom.installBtn.addEventListener('click', closeMenu);
        dom.importFile.addEventListener('change', event => {
            closeMenu();
            importBackup(event);
        });

        dom.closeManualBtn.addEventListener('click', closeManual);
        dom.confirmManualBtn.addEventListener('click', closeManual);
        dom.manualModal.addEventListener('click', event => {
            if (event.target === dom.manualModal) {
                closeManual();
            }
        });

        dom.voiceBtn.addEventListener('click', startVoiceInput);
        dom.stopVoiceBtn.addEventListener('click', stopVoiceInput);
        dom.restartVoiceBtn.addEventListener('click', restartVoiceInput);
        dom.undoVoiceBtn.addEventListener('click', undoLastVoiceInput);
        dom.nextVoiceBtn.addEventListener('click', moveToNextSampleByVoice);
        dom.confirmVoiceCompleteBtn.addEventListener('click', confirmVoiceComplete);
        dom.cancelVoiceCompleteBtn.addEventListener('click', closeVoiceComplete);
        dom.voiceCompleteModal.addEventListener('click', event => {
            if (event.target === dom.voiceCompleteModal) {
                closeVoiceComplete();
            }
        });

        dom.clearBtn.addEventListener('click', clearCurrentSample);
        dom.nextBtn.addEventListener('click', goToNextSample);
        document.addEventListener('keydown', handleModalKeydown);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        dom.voiceRangeMin.addEventListener('change', updateVoiceRange);
        dom.voiceRangeMax.addEventListener('change', updateVoiceRange);
    }

    function cacheDom() {
        dom = {
            materialPicker: document.getElementById('materialPicker'),
            materialTrigger: document.getElementById('materialTrigger'),
            materialPanel: document.getElementById('materialPanel'),
            materialList: document.getElementById('materialList'),
            sampleSelector: document.getElementById('sampleSelector'),
            dataGrid: document.getElementById('dataGrid'),
            currentSampleTitle: document.getElementById('currentSampleTitle'),
            progressIndicator: document.getElementById('progressIndicator'),
            progressTrack: document.getElementById('progressTrack'),
            progressBar: document.getElementById('progressBar'),
            minValue: document.getElementById('minValue'),
            avgValue: document.getElementById('avgValue'),
            summaryTableBody: document.getElementById('summaryTableBody'),
            saveStatus: document.getElementById('saveStatus'),
            saveStatusText: document.getElementById('saveStatusText'),
            toast: document.getElementById('toast'),
            menuBtn: document.getElementById('menuBtn'),
            menuModal: document.getElementById('menuModal'),
            closeMenuBtn: document.getElementById('closeMenuBtn'),
            voiceRangeMin: document.getElementById('voiceRangeMin'),
            voiceRangeMax: document.getElementById('voiceRangeMax'),
            addMaterialBtn: document.getElementById('addMaterialBtn'),
            deleteMaterialModal: document.getElementById('deleteMaterialModal'),
            deleteMaterialTitle: document.getElementById('deleteMaterialTitle'),
            deleteMaterialMessage: document.getElementById('deleteMaterialMessage'),
            cancelDeleteMaterialBtn: document.getElementById('cancelDeleteMaterialBtn'),
            confirmDeleteMaterialBtn: document.getElementById('confirmDeleteMaterialBtn'),
            manualBtn: document.getElementById('manualBtn'),
            installBtn: document.getElementById('installBtn'),
            manualModal: document.getElementById('manualModal'),
            closeManualBtn: document.getElementById('closeManualBtn'),
            confirmManualBtn: document.getElementById('confirmManualBtn'),
            voiceBtn: document.getElementById('voiceBtn'),
            voiceModal: document.getElementById('voiceModal'),
            voiceVisualization: document.getElementById('voiceVisualization'),
            voiceStatus: document.getElementById('voiceStatus'),
            voiceResult: document.getElementById('voiceResult'),
            voiceProgressIndicator: document.getElementById('voiceProgressIndicator'),
            voiceProgressTrack: document.getElementById('voiceProgressTrack'),
            voiceProgressBar: document.getElementById('voiceProgressBar'),
            stopVoiceBtn: document.getElementById('stopVoiceBtn'),
            restartVoiceBtn: document.getElementById('restartVoiceBtn'),
            undoVoiceBtn: document.getElementById('undoVoiceBtn'),
            nextVoiceBtn: document.getElementById('nextVoiceBtn'),
            voiceCompleteModal: document.getElementById('voiceCompleteModal'),
            voiceCompleteTitle: document.getElementById('voiceCompleteTitle'),
            voiceCompleteMessage: document.getElementById('voiceCompleteMessage'),
            confirmVoiceCompleteBtn: document.getElementById('confirmVoiceCompleteBtn'),
            cancelVoiceCompleteBtn: document.getElementById('cancelVoiceCompleteBtn'),
            clearBtn: document.getElementById('clearBtn'),
            nextBtn: document.getElementById('nextBtn'),
            exportCurrentBtn: document.getElementById('exportCurrentBtn'),
            exportAllBtn: document.getElementById('exportAllBtn'),
            backupBtn: document.getElementById('backupBtn'),
            importFile: document.getElementById('importFile')
        };
    }

    document.addEventListener('DOMContentLoaded', () => {
        cacheDom();
        bindEvents();
        const loadResult = initializeData();
        loadVoiceRange();
        renderVoiceRange();
        renderAll();
        setSaveStatus('saved', loadResult.loaded ? '저장 데이터 복원됨' : '새 측정 준비됨');
        if (loadResult.migrated) {
            saveData('기존 데이터 변환 완료');
        }
        setupPwa();
    });
})();

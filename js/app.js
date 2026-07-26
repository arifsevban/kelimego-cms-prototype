import { initializeApp, deleteApp, getApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getDatabase, ref, set, onValue, remove, get } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js';

function toTurkishLowerCase(str) {
    if (!str) return '';
    return str
        .replace(/I/g, 'ı')
        .replace(/İ/g, 'i')
        .toLowerCase()
        .trim();
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function migrateQuestionToMap(qData) {
    let acceptableAnswersMap = {};

    if (qData.acceptable_answers && typeof qData.acceptable_answers === 'object' && !Array.isArray(qData.acceptable_answers)) {
        for (const [key, list] of Object.entries(qData.acceptable_answers)) {
            const normKey = toTurkishLowerCase(key.trim());
            const normList = (list || []).map(a => toTurkishLowerCase(a.trim())).filter(Boolean);
            if (normKey) {
                if (!normList.includes(normKey)) {
                    normList.unshift(normKey);
                }
                acceptableAnswersMap[normKey] = normList;
            }
        }
        return acceptableAnswersMap;
    }

    if (qData.answers && Array.isArray(qData.answers) && qData.answers.length > 0) {
        qData.answers.forEach(ans => {
            const mainAns = ans.correctAnswer || '';
            const normKey = toTurkishLowerCase(mainAns.trim());
            if (normKey) {
                const normList = (ans.acceptable_answers || []).map(a => toTurkishLowerCase(a.trim())).filter(Boolean);
                if (!normList.includes(normKey)) {
                    normList.unshift(normKey);
                }
                acceptableAnswersMap[normKey] = normList;
            }
        });
        return acceptableAnswersMap;
    }

    const oldList = qData.acceptable_answers || qData.accepted_answers || [];
    const oldCorrect = qData.correctAnswer || '';

    const used = new Set();
    const firstMain = toTurkishLowerCase(oldCorrect.trim());
    const firstAlts = [];

    if (firstMain) {
        used.add(firstMain);
        firstAlts.push(firstMain);
    }

    const flatList = oldList.map(a => toTurkishLowerCase(a.trim())).filter(Boolean);

    flatList.forEach(norm => {
        if (used.has(norm)) return;
        if (firstMain && (firstMain.includes(norm) || norm.includes(firstMain))) {
            firstAlts.push(norm);
            used.add(norm);
        }
    });

    if (firstMain) {
        acceptableAnswersMap[firstMain] = firstAlts;
    }

    flatList.forEach(norm => {
        if (used.has(norm)) return;

        const currentMain = norm;
        used.add(currentMain);
        const currentAlts = [currentMain];

        flatList.forEach(otherNorm => {
            if (used.has(otherNorm)) return;
            if (currentMain.includes(otherNorm) || otherNorm.includes(currentMain)) {
                currentAlts.push(otherNorm);
                used.add(otherNorm);
            }
        });

        acceptableAnswersMap[currentMain] = currentAlts;
    });

    return acceptableAnswersMap;
}

const PLACEHOLDERS = {
    genel_kultur: ["örn: pusula", "örn: galileo", "örn: oksijen", "örn: rönesans"],
    tarih: ["örn: 1453", "örn: osman bey", "örn: lozan antlaşması", "örn: göktürkler"],
    spor: ["örn: penaltı", "örn: maraton", "örn: olimpiyatlar", "örn: ofsayt"],
    cografya: ["örn: ege denizi", "örn: ekvator", "örn: kızılırmak", "örn: antarktika"],
    sinema_sanat: ["örn: mona lisa", "örn: nuri bilge ceylan", "örn: oscar", "örn: sürrealizm"],
    muzik: ["örn: keman", "örn: barış manço", "örn: beethoven", "örn: sol anahtarı"],
    edebiyat: ["örn: roman", "örn: halide edip adıvar", "örn: araba sevdası", "örn: nazım hikmet"],
    bilim_teknoloji: ["örn: yapay zeka", "örn: dna", "örn: karadelik", "örn: kuantum"]
};

let firebaseApp = null;
let db = null;
let isFirebaseConnected = false;
let questionsData = {}; // Stores all questions from DB
let questionsListener = null;

let isEditMode = false;
let editQuestionId = null;
let editOriginalCategory = null;

const toastContainer = document.getElementById('toast-container');
const configPanel = document.getElementById('config-panel');
const toggleConfigBtn = document.getElementById('toggle-config-btn');
const closeConfigBtn = document.getElementById('close-config-btn');
const configForm = document.getElementById('config-form');
const resetConfigBtn = document.getElementById('reset-config-btn');
const migrateDbBtn = document.getElementById('migrate-db-btn');
const dbStatusBadge = document.getElementById('db-status-badge');
const exportBackupBtn = document.getElementById('export-backup-btn');
const importBackupInput = document.getElementById('import-backup-input');

const questionForm = document.getElementById('question-form');
const formTitle = document.getElementById('form-title');
const categorySelect = document.getElementById('category');
const questionTextarea = document.getElementById('question');
const addAnswerBtn = document.getElementById('add-answer-btn');
const answersContainer = document.getElementById('answers-container');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

const submitBtn = document.getElementById('submit-btn');
const submitBtnText = document.getElementById('submit-btn-text');
const submitSpinner = document.getElementById('submit-spinner');

const searchInput = document.getElementById('search-input');
const filterCategory = document.getElementById('filter-category');
const questionsListContainer = document.getElementById('questions-list-container');
const listCountSpan = document.getElementById('list-count');
const newCategoryInput = document.getElementById('new-category-input');
const addCategoryBtn = document.getElementById('add-category-btn');

const viewAllQuestionsBtn = document.getElementById('view-all-questions-btn');
const viewAllModal = document.getElementById('view-all-modal');
const viewAllBackdrop = document.getElementById('view-all-backdrop');
const viewAllCard = document.getElementById('view-all-card');
const viewAllCountSpan = document.getElementById('view-all-count');
const viewAllCloseBtn = document.getElementById('view-all-close-btn');
const viewAllSearchQuestionInput = document.getElementById('view-all-search-question');
const viewAllSearchAnswerInput = document.getElementById('view-all-search-answer');
const viewAllFilterCategory = document.getElementById('view-all-filter-category');
const viewAllListContainer = document.getElementById('view-all-list-container');

const DEFAULT_CATEGORIES = [
    { value: 'genel_kultur', label: 'Genel Kültür' },
    { value: 'tarih', label: 'Tarih' },
    { value: 'spor', label: 'Spor' },
    { value: 'cografya', label: 'Coğrafya' },
    { value: 'sinema_sanat', label: 'Sinema & Sanat' },
    { value: 'muzik', label: 'Müzik' },
    { value: 'edebiyat', label: 'Edebiyat' },
    { value: 'bilim_teknoloji', label: 'Bilim & Teknoloji' },
];

let categoriesCache = null;
let categoriesListener = null;

function loadCategories() {
    if (categoriesCache) return categoriesCache;
    const saved = localStorage.getItem('cms_categories');
    return saved ? JSON.parse(saved) : DEFAULT_CATEGORIES;
}

function saveCategories(cats) {
    categoriesCache = cats;
    localStorage.setItem('cms_categories', JSON.stringify(cats));

    if (db) {
        const catRef = ref(db, 'cms_categories');
        set(catRef, cats).catch(err => console.error('Category sync error:', err));
    }
}

function slugify(str) {
    return str.trim()
        .toLocaleLowerCase('tr-TR')
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
        .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function populateCategoryDropdowns() {
    const cats = loadCategories();
    const currentVal = categorySelect.value;
    const currentFilter = filterCategory.value;

    categorySelect.innerHTML = '<option value="" disabled>Kategori seçiniz...</option>';
    cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.value;
        opt.textContent = `${c.label} (${c.value})`;
        categorySelect.appendChild(opt);
    });
    if (currentVal) categorySelect.value = currentVal;

    filterCategory.innerHTML = '<option value="all">Tüm Kategoriler</option>';
    cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.value;
        opt.textContent = `${c.label} (${c.value})`;
        filterCategory.appendChild(opt);
    });
    if (currentFilter) filterCategory.value = currentFilter;

    if (viewAllFilterCategory) {
        const currentViewAllFilter = viewAllFilterCategory.value;
        viewAllFilterCategory.innerHTML = '<option value="all">Tüm Kategoriler</option>';
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.value;
            opt.textContent = `${c.label} (${c.value})`;
            viewAllFilterCategory.appendChild(opt);
        });
        if (currentViewAllFilter) viewAllFilterCategory.value = currentViewAllFilter;
    }
}

populateCategoryDropdowns();

addCategoryBtn.onclick = () => {
    const rawName = newCategoryInput.value.trim();
    if (!rawName) return;
    const slug = slugify(rawName);
    if (!slug) { showToast('Geçerli bir kategori adı girin.', 'error'); return; }

    const cats = loadCategories();
    if (cats.some(c => c.value === slug)) {
        showToast('Bu kategori zaten mevcut.', 'error');
        return;
    }
    cats.push({ value: slug, label: rawName });
    saveCategories(cats);
    populateCategoryDropdowns();
    if (!categoryManageList.classList.contains('hidden')) renderCategoryManageList();
    categorySelect.value = slug;
    newCategoryInput.value = '';
    showToast(`"${rawName}" kategorisi eklendi.`, 'success');
};

newCategoryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCategoryBtn.click(); }
});

const categoryManageList = document.getElementById('category-manage-list');
const toggleManageCatsBtn = document.getElementById('toggle-manage-cats-btn');
const toggleManageCatsText = document.getElementById('toggle-manage-cats-text');

toggleManageCatsBtn.onclick = () => {
    const isHidden = categoryManageList.classList.toggle('hidden');
    toggleManageCatsText.textContent = isHidden ? 'Kategorileri Yönet' : 'Yönetimi Kapat';
    if (!isHidden) renderCategoryManageList();
};

function renderCategoryManageList() {
    const cats = loadCategories();
    categoryManageList.innerHTML = '';
    cats.forEach((c, idx) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 bg-black border border-neutral-800 rounded-lg px-3 py-1.5';

        const label = document.createElement('span');
        label.className = 'flex-1 text-xs text-neutral-300 truncate';
        label.textContent = `${c.label} (${c.value})`;

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'p-1 text-neutral-500 hover:text-emerald-400 transition cursor-pointer';
        renameBtn.title = 'Yeniden Adlandır';
        renameBtn.innerHTML = '<i data-lucide="pencil" class="w-3.5 h-3.5"></i>';
        renameBtn.onclick = () => renameCategory(idx);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'p-1 text-neutral-500 hover:text-red-400 transition cursor-pointer';
        deleteBtn.title = 'Kategoriyi Sil';
        deleteBtn.innerHTML = '<i data-lucide="trash-2" class="w-3.5 h-3.5"></i>';
        deleteBtn.onclick = () => deleteCategory(idx);

        row.appendChild(label);
        row.appendChild(renameBtn);
        row.appendChild(deleteBtn);
        categoryManageList.appendChild(row);
    });
    lucide.createIcons();
}

async function renameCategory(idx) {
    const cats = loadCategories();
    const cat = cats[idx];
    const newName = await appPrompt(`"${cat.label}" kategorisinin yeni adını girin:`, cat.label);
    if (!newName || newName.trim() === '' || newName.trim() === cat.label) return;
    cats[idx].label = newName.trim();
    saveCategories(cats);
    populateCategoryDropdowns();
    renderCategoryManageList();
    showToast(`Kategori "${newName.trim()}" olarak güncellendi.`, 'success');
}

async function deleteCategory(idx) {
    const cats = loadCategories();
    const cat = cats[idx];
    const confirmed = await appConfirm(`"${cat.label}" kategorisini silmek istediğinize emin misiniz?`);
    if (!confirmed) return;
    cats.splice(idx, 1);
    saveCategories(cats);
    populateCategoryDropdowns();
    renderCategoryManageList();
    showToast(`"${cat.label}" kategorisi silindi.`, 'success');
}

const toggleQuestionsBtn = document.getElementById('toggle-questions-btn');

toggleQuestionsBtn.onclick = () => {
    const isHidden = questionsListContainer.classList.toggle('hidden');
    toggleQuestionsBtn.innerHTML = isHidden
        ? '<i data-lucide="eye-off" class="w-4 h-4"></i>'
        : '<i data-lucide="eye" class="w-4 h-4"></i>';
    toggleQuestionsBtn.title = isHidden ? 'Soruları Göster' : 'Soruları Gizle';
    lucide.createIcons();
};

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `flex items-center gap-3 p-4 rounded-2xl border backdrop-blur-md shadow-lg pointer-events-auto transform translate-y-2 opacity-0 transition-all duration-300`;

    let bgClass = '', borderClass = '', textClass = '', icon = '';
    if (type === 'success') {
        bgClass = 'bg-neutral-900/95';
        borderClass = 'border-emerald-900/40';
        textClass = 'text-emerald-400';
        icon = 'check-circle';
    } else if (type === 'error') {
        bgClass = 'bg-neutral-900/95';
        borderClass = 'border-red-900/40';
        textClass = 'text-red-400';
        icon = 'alert-triangle';
    } else {
        bgClass = 'bg-neutral-900/95';
        borderClass = 'border-neutral-800';
        textClass = 'text-neutral-200';
        icon = 'info';
    }

    toast.className += ` ${bgClass} ${borderClass} ${textClass}`;
    toast.innerHTML = `
        <i data-lucide="${icon}" class="w-5 h-5 flex-shrink-0"></i>
        <div class="text-xs font-semibold flex-1 leading-relaxed">${message}</div>
        <button type="button" class="text-neutral-400 hover:text-white transition focus:outline-none cursor-pointer">
            <i data-lucide="x" class="w-4 h-4"></i>
        </button>
    `;

    toastContainer.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    }, 10);

    const closeBtn = toast.querySelector('button');
    closeBtn.onclick = () => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-2', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    };

    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.remove('translate-y-0', 'opacity-100');
            toast.classList.add('translate-y-2', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }
    }, 4500);
}

async function exportBackupData() {
    if (!db) {
        showToast('Firebase bağlantısı yok. Önce veritabanını yapılandırın.', 'error');
        return;
    }

    exportBackupBtn.disabled = true;
    exportBackupBtn.innerHTML = '<i data-lucide="loader-circle" class="w-4 h-4 text-emerald-400 animate-spin"></i>';
    lucide.createIcons();

    try {
        const questionsSnapshot = await get(ref(db, 'questions_pool'));
        const categoriesSnapshot = await get(ref(db, 'cms_categories'));

        const questionsData = questionsSnapshot.exists() ? questionsSnapshot.val() : {};
        const categoriesData = categoriesSnapshot.exists() ? categoriesSnapshot.val() : [];

        const backup = {
            app: 'KelimeGo CMS',
            version: '1.0',
            exported_at: new Date().toISOString(),
            questions_pool: questionsData,
            cms_categories: categoriesData
        };

        const json = JSON.stringify(backup, null, 2);
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const datestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const filename = `kelimego_yedek_${datestamp}.json`;

        if ('showSaveFilePicker' in window) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'JSON Dosyası',
                        accept: { 'application/json': ['.json'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                showToast(`"${filename}" başarıyla kaydedildi.`, 'success');
            } catch (err) {
                if (err.name === 'AbortError') {

                    return;
                }
                throw err;
            }
        } else {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast(`"${filename}" indirme işlemi başlatıldı.`, 'info');
        }
    } catch (err) {
        console.error('Backup export error:', err);
        showToast('Yedekleme sırasında bir hata oluştu: ' + err.message, 'error');
    } finally {
        exportBackupBtn.disabled = false;
        exportBackupBtn.innerHTML = '<i data-lucide="download" class="w-4 h-4 text-emerald-400"></i>';
        lucide.createIcons();
    }
}

async function importBackupData(file) {
    if (!db) {
        showToast('Firebase bağlantısı yok. Önce veritabanını yapılandırın.', 'error');
        return;
    }

    if (!file || file.size === 0) {
        showToast('Seçilen dosya boş veya geçersiz.', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = (e.target.result || '').trim();

        if (!text) {
            showToast('Dosya içeriği boş.', 'error');
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            showToast('Geçersiz JSON formatı. Lütfen geçerli bir yedek dosyası seçin.', 'error');
            return;
        }

        let questionsPool = null;
        let categoriesData = null;

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (parsed.questions_pool && typeof parsed.questions_pool === 'object') {

                questionsPool = parsed.questions_pool;
                categoriesData = Array.isArray(parsed.cms_categories) ? parsed.cms_categories : null;
            } else {

                const keys = Object.keys(parsed);
                const isPool = keys.length > 0 && keys.every(k => {
                    const cat = parsed[k];
                    return typeof cat === 'object' && !Array.isArray(cat) &&
                        Object.values(cat).every(q =>
                            typeof q === 'object' && ('question' in q || 'acceptable_answers' in q || 'answers' in q)
                        );
                });
                if (isPool) {
                    questionsPool = parsed;
                }
            }
        }

        if (!questionsPool) {
            showToast('Bu dosya KelimeGo soru şemasına uygun değil. Lütfen geçerli bir yedek dosyası seçin.', 'error');
            return;
        }

        const questionCount = Object.values(questionsPool).reduce((sum, cat) => sum + Object.keys(cat).length, 0);

        const confirmed = await appConfirm(
            `Bu işlem veritabanındaki tüm soruları bu yedek dosyasındaki ${questionCount} soru ile değiştirecektir. Devam etmek istediğinize emin misiniz?`
        );
        if (!confirmed) return;

        try {
            await set(ref(db, 'questions_pool'), questionsPool);
            if (categoriesData && categoriesData.length > 0) {
                await set(ref(db, 'cms_categories'), categoriesData);
            }
            showToast(`${questionCount} soru başarıyla içe aktarıldı.`, 'success');
        } catch (err) {
            console.error('Import error:', err);
            showToast('İçe aktarma sırasında bir hata oluştu: ' + err.message, 'error');
        }
    };

    reader.onerror = () => {
        showToast('Dosya okunurken bir hata oluştu.', 'error');
    };

    reader.readAsText(file);
}

function openViewAllModal() {
    if (viewAllSearchQuestionInput) viewAllSearchQuestionInput.value = '';
    if (viewAllSearchAnswerInput) viewAllSearchAnswerInput.value = '';
    if (viewAllFilterCategory) viewAllFilterCategory.value = 'all';

    viewAllModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    requestAnimationFrame(() => {
        viewAllCard.classList.remove('scale-95', 'opacity-0');
        viewAllCard.classList.add('scale-100', 'opacity-100');
    });
    renderViewAllQuestionList();
}

function closeViewAllModal(immediate = false) {
    viewAllCard.classList.remove('scale-100', 'opacity-100');
    viewAllCard.classList.add('scale-95', 'opacity-0');
    document.body.classList.remove('overflow-hidden');
    if (immediate) {
        viewAllModal.classList.add('hidden');
    } else {
        setTimeout(() => {
            viewAllModal.classList.add('hidden');
        }, 200);
    }
}

function renderViewAllQuestionList() {
    const questionSearchQuery = viewAllSearchQuestionInput ? viewAllSearchQuestionInput.value.toLowerCase().trim() : '';
    const answerSearchQuery = viewAllSearchAnswerInput ? viewAllSearchAnswerInput.value.toLowerCase().trim() : '';
    const categoryFilter = viewAllFilterCategory ? viewAllFilterCategory.value : 'all';

    const questionsArray = [];

    for (const categoryId in questionsData) {
        if (categoryFilter !== 'all' && categoryId !== categoryFilter) {
            continue;
        }
        const categoryObj = questionsData[categoryId];
        for (const questionId in categoryObj) {
            const qData = categoryObj[questionId];

            const acceptableAnswersMap = migrateQuestionToMap(qData);

            if (questionSearchQuery) {
                const questionText = (qData.question || '').toLowerCase();
                if (!questionText.includes(questionSearchQuery)) {
                    continue;
                }
            }

            if (answerSearchQuery) {
                const searchParts = [];
                Object.entries(acceptableAnswersMap).forEach(([key, list]) => {
                    searchParts.push(key);
                    list.forEach(item => searchParts.push(item));
                });
                const answersText = searchParts.join(' ').toLowerCase();
                if (!answersText.includes(answerSearchQuery)) {
                    continue;
                }
            }

            questionsArray.push({
                id: questionId,
                category: categoryId,
                question: qData.question,
                acceptable_answers: acceptableAnswersMap
            });
        }
    }

    questionsArray.sort((a, b) => b.id.localeCompare(a.id));

    if (viewAllCountSpan) {
        viewAllCountSpan.textContent = `${questionsArray.length} soru`;
    }

    if (!viewAllListContainer) return;

    if (questionsArray.length === 0) {
        viewAllListContainer.innerHTML = `
            <div class="col-span-full text-center py-20 text-neutral-500 text-sm">
                <i data-lucide="clipboard-list" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
                Arama kriterlerine uygun soru bulunamadı.
            </div>
        `;
        lucide.createIcons();
        return;
    }

    viewAllListContainer.innerHTML = '';
    questionsArray.forEach(q => {
        const card = document.createElement('div');
        card.className = "bg-black border border-neutral-800 rounded-2xl p-4 flex flex-col justify-between gap-3 transition hover:border-emerald-900/60 hover:shadow-[0_0_15px_rgba(16,185,129,0.02)]";

        const categoryNames = {};
        loadCategories().forEach(c => { categoryNames[c.value] = c.label; });
        const catName = categoryNames[q.category] || q.category;

        card.innerHTML = `
            <div class="space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="px-2 py-0.5 bg-emerald-950/20 text-emerald-400 border border-emerald-900/30 rounded-md text-[10px] font-bold uppercase tracking-wider">
                        ${catName}
                    </span>
                    <span class="text-[10px] font-mono text-neutral-500 font-medium">
                        ${q.id}
                    </span>
                </div>
                <p class="text-sm font-semibold text-neutral-100 leading-snug">${escapeHtml(q.question)}</p>

                <div class="answers-wrapper hidden pt-2 border-t border-neutral-900/40 mt-1.5 space-y-1.5">
                    <span class="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1 font-bold">Kabul Edilen Cevaplar (Alternatifler için tıklayın):</span>
                    <div class="flex flex-wrap gap-2">
                        ${Object.entries(q.acceptable_answers || {}).map(([key, list]) => `
                            <div class="relative inline-block">
                                <button type="button" class="answer-badge px-2.5 py-1 bg-neutral-950 hover:bg-neutral-900 border border-neutral-855 hover:border-neutral-700 rounded-lg text-xs text-neutral-200 font-semibold cursor-pointer transition flex items-center gap-1.5 select-none font-sans">
                                    <span>${escapeHtml(key)}</span>
                                    ${list && list.length > 1 ? `<i data-lucide="git-branch" class="w-3 h-3 text-emerald-500"></i>` : ''}
                                </button>
                                <div class="alt-popover hidden absolute left-0 top-full mt-1.5 z-20 w-52 bg-neutral-900 border border-neutral-800 rounded-xl p-2.5 shadow-2xl text-[11px] text-neutral-300 transform origin-top scale-95 opacity-0 transition-all duration-150 pointer-events-auto font-sans">
                                    <div class="absolute -top-1 left-4 w-2 h-2 bg-neutral-900 border-t border-l border-neutral-800 rotate-45"></div>
                                    <div class="font-bold text-[9px] uppercase tracking-wider text-neutral-500 mb-1 flex items-center gap-1">
                                        <i data-lucide="git-branch" class="w-3 h-3 text-emerald-400"></i>
                                        <span>Alternatif Cevaplar</span>
                                    </div>
                                    <div class="flex flex-wrap gap-1 mt-1.5">
                                        ${list && list.length > 1 ?
                list.slice(1).map(alt => `<span class="px-1.5 py-0.5 bg-black border border-neutral-850 rounded text-neutral-300 font-mono">${escapeHtml(alt)}</span>`).join('')
                : `<span class="text-neutral-500 italic">Alternatif tanımlanmamış</span>`
            }
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-neutral-900/60 pt-3 mt-1">
                <button type="button" class="toggle-answers-btn shrink-0 px-1 py-1.5 min-[340px]:px-1.5 sm:px-2.5 sm:py-1.5 bg-neutral-950 hover:bg-neutral-900 border border-neutral-855 hover:border-neutral-800 text-neutral-400 hover:text-neutral-200 rounded-lg text-[9px] min-[340px]:text-[10px] sm:text-xs font-semibold transition cursor-pointer flex items-center gap-0.5 min-[340px]:gap-1 sm:gap-1.5 whitespace-nowrap">
                    <i data-lucide="eye" class="w-3 h-3 sm:w-3.5 sm:h-3.5 eye-icon shrink-0"></i>
                    <span class="btn-text whitespace-nowrap">Cevapları Gör</span>
                </button>

                <div class="flex items-center gap-1 sm:gap-2 shrink-0">
                    <button type="button" class="change-cat-btn px-2 py-1.5 sm:px-2.5 sm:py-1.5 bg-neutral-950 hover:bg-emerald-950/20 border border-neutral-855 hover:border-emerald-900/30 text-neutral-400 hover:text-emerald-400 rounded-lg text-[10px] sm:text-xs font-semibold transition cursor-pointer flex items-center justify-center shrink-0" title="Kategori Değiştir">
                        <i data-lucide="folder-sync" class="w-3 h-3"></i>
                    </button>
                    <button type="button" class="edit-q-btn px-2 py-1.5 sm:px-3 sm:py-1.5 bg-white hover:bg-emerald-50 hover:text-emerald-950 text-black rounded-lg text-[10px] sm:text-xs font-bold transition cursor-pointer flex items-center gap-1 sm:gap-1.5 shrink-0">
                        <i data-lucide="pencil" class="w-3 h-3"></i>
                        <span class="hidden sm:inline">Düzenle</span>
                    </button>
                    <button type="button" class="delete-q-btn px-2 py-1.5 sm:px-3 sm:py-1.5 bg-neutral-950 hover:bg-red-950/20 hover:text-red-400 hover:border-red-900/40 border border-neutral-855 text-neutral-500 rounded-lg text-[10px] sm:text-xs font-semibold transition cursor-pointer flex items-center gap-1 sm:gap-1.5 shrink-0">
                        <i data-lucide="trash-2" class="w-3 h-3"></i>
                        <span class="hidden sm:inline">Sil</span>
                    </button>
                </div>
            </div>
        `;

        const toggleAnswersBtn = card.querySelector('.toggle-answers-btn');
        const answersWrapper = card.querySelector('.answers-wrapper');
        const eyeIcon = toggleAnswersBtn.querySelector('.eye-icon');
        const btnText = toggleAnswersBtn.querySelector('.btn-text');

        toggleAnswersBtn.onclick = () => {
            const isHidden = answersWrapper.classList.toggle('hidden');
            toggleAnswersBtn.innerHTML = isHidden
                ? '<i data-lucide="eye" class="w-3 h-3 sm:w-3.5 sm:h-3.5 eye-icon shrink-0"></i><span class="btn-text whitespace-nowrap">Cevapları Gör</span>'
                : '<i data-lucide="eye-off" class="w-3 h-3 sm:w-3.5 sm:h-3.5 eye-icon shrink-0"></i><span class="btn-text whitespace-nowrap">Cevapları Gizle</span>';
            lucide.createIcons();
        };

        const popovers = card.querySelectorAll('.alt-popover');
        const badgeBtns = card.querySelectorAll('.answer-badge');

        badgeBtns.forEach((btn, idx) => {
            const popover = popovers[idx];
            btn.onclick = (e) => {
                e.stopPropagation();

                document.querySelectorAll('.alt-popover').forEach(p => {
                    if (p !== popover) {
                        p.classList.add('hidden', 'scale-95', 'opacity-0');
                        p.classList.remove('scale-100', 'opacity-100');
                    }
                });

                const isHidden = popover.classList.contains('hidden');
                if (isHidden) {
                    popover.classList.remove('hidden');
                    setTimeout(() => {
                        popover.classList.remove('scale-95', 'opacity-0');
                        popover.classList.add('scale-100', 'opacity-100');
                    }, 10);
                } else {
                    popover.classList.remove('scale-100', 'opacity-100');
                    popover.classList.add('scale-95', 'opacity-0');
                    setTimeout(() => {
                        popover.classList.add('hidden');
                    }, 150);
                }
            };
        });

        card.querySelector('.edit-q-btn').onclick = () => {
            closeViewAllModal(true);
            startEditQuestion(q);
        };
        card.querySelector('.delete-q-btn').onclick = () => {
            deleteQuestion(q.category, q.id);
        };
        card.querySelector('.change-cat-btn').onclick = () => {
            changeCategoryOfQuestion(q);
        };

        viewAllListContainer.appendChild(card);
    });

    lucide.createIcons();
}

const appModal = document.getElementById('app-modal');
const modalCard = document.getElementById('modal-card');
const modalMessage = document.getElementById('modal-message');
const modalInput = document.getElementById('modal-input');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalBackdrop = document.getElementById('modal-backdrop');

function showModal() {
    appModal.classList.remove('hidden');
    requestAnimationFrame(() => {
        modalCard.classList.remove('scale-95', 'opacity-0');
        modalCard.classList.add('scale-100', 'opacity-100');
    });
}

function hideModal() {
    modalCard.classList.remove('scale-100', 'opacity-100');
    modalCard.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
        appModal.classList.add('hidden');
        modalInput.classList.add('hidden');
        modalInput.value = '';
    }, 200);
}

function appConfirm(message) {
    return new Promise((resolve) => {
        modalMessage.textContent = message;
        modalInput.classList.add('hidden');
        modalConfirmBtn.textContent = 'Onayla';
        showModal();

        const cleanup = () => {
            modalConfirmBtn.onclick = null;
            modalCancelBtn.onclick = null;
            modalBackdrop.onclick = null;
            hideModal();
        };

        modalConfirmBtn.onclick = () => { cleanup(); resolve(true); };
        modalCancelBtn.onclick = () => { cleanup(); resolve(false); };
        modalBackdrop.onclick = () => { cleanup(); resolve(false); };
    });
}

function appPrompt(message, defaultValue = '') {
    return new Promise((resolve) => {
        modalMessage.textContent = message;
        modalInput.classList.remove('hidden');
        modalInput.value = defaultValue;
        modalConfirmBtn.textContent = 'Kaydet';
        showModal();
        setTimeout(() => modalInput.focus(), 100);

        const cleanup = () => {
            modalConfirmBtn.onclick = null;
            modalCancelBtn.onclick = null;
            modalBackdrop.onclick = null;
            modalInput.onkeydown = null;
            hideModal();
        };

        modalConfirmBtn.onclick = () => { const v = modalInput.value; cleanup(); resolve(v); };
        modalCancelBtn.onclick = () => { cleanup(); resolve(null); };
        modalBackdrop.onclick = () => { cleanup(); resolve(null); };
        modalInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); const v = modalInput.value; cleanup(); resolve(v); }
            if (e.key === 'Escape') { cleanup(); resolve(null); }
        };
    });
}

function loadConfigFromStorage() {
    const saved = localStorage.getItem('firebase_cms_config');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            document.getElementById('cfg-apiKey').value = parsed.apiKey || '';
            document.getElementById('cfg-authDomain').value = parsed.authDomain || '';
            document.getElementById('cfg-databaseURL').value = parsed.databaseURL || '';
            document.getElementById('cfg-projectId').value = parsed.projectId || '';
            document.getElementById('cfg-storageBucket').value = parsed.storageBucket || '';
            document.getElementById('cfg-appId').value = parsed.appId || '';
            return parsed;
        } catch (e) {
            console.error("Storage config parse error", e);
        }
    }
    return null;
}

function updateConnectionBadge(connected, message = '') {
    isFirebaseConnected = connected;
    if (connected) {
        dbStatusBadge.className = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-neutral-900 text-neutral-200 border border-neutral-800";
        dbStatusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Firebase Bağlı`;
        if (message) showToast(message, 'success');
    } else {
        dbStatusBadge.className = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-neutral-900 text-neutral-400 border border-neutral-800";
        dbStatusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span> Bağlantı Yok`;
        if (message) showToast(message, 'error');
    }
}

async function setupFirebase(config) {
    if (!config || !config.databaseURL || !config.apiKey) {
        updateConnectionBadge(false);
        return false;
    }

    try {

        try {
            const currentApp = getApp();
            await deleteApp(currentApp);
        } catch (e) { }

        firebaseApp = initializeApp(config);
        db = getDatabase(firebaseApp);
        updateConnectionBadge(true, "Firebase yapılandırması başarıyla uygulandı.");

        listenToQuestions();

        listenToCategories();

        return true;
    } catch (err) {
        console.error("Firebase startup failure", err);
        updateConnectionBadge(false, "Firebase bağlantısı başarısız oldu: " + err.message);
        return false;
    }
}

function listenToQuestions() {
    if (!db) return;

    if (typeof questionsListener === 'function') {
        questionsListener();
    }

    const dbRef = ref(db, 'questions_pool');

    try {
        questionsListener = onValue(dbRef, (snapshot) => {
            if (snapshot.exists()) {
                questionsData = snapshot.val();
            } else {
                questionsData = {};
            }
            renderQuestionList();
        }, (error) => {
            console.error("Firebase read error:", error);
            showToast("Soru listesi yüklenemedi: " + error.message, "error");
        });
    } catch (err) {
        console.error("Error setting up listener:", err);
    }
}

function listenToCategories() {
    if (!db) return;

    if (typeof categoriesListener === 'function') {
        categoriesListener();
    }

    const catRef = ref(db, 'cms_categories');

    try {
        categoriesListener = onValue(catRef, (snapshot) => {
            if (snapshot.exists()) {
                const firebaseCats = snapshot.val();

                if (Array.isArray(firebaseCats) && firebaseCats.length > 0) {
                    categoriesCache = firebaseCats;
                    localStorage.setItem('cms_categories', JSON.stringify(firebaseCats));
                    populateCategoryDropdowns();
                    if (!categoryManageList.classList.contains('hidden')) renderCategoryManageList();
                }
            } else {

                const localCats = loadCategories();
                set(catRef, localCats).catch(err => console.error('Initial category push error:', err));
            }
        }, (error) => {
            console.error("Firebase categories read error:", error);
        });
    } catch (err) {
        console.error("Error setting up categories listener:", err);
    }
}

function renderQuestionList() {
    const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const categoryFilter = filterCategory ? filterCategory.value : 'all';

    const questionsArray = [];

    for (const categoryId in questionsData) {
        if (categoryFilter !== 'all' && categoryId !== categoryFilter) {
            continue;
        }
        const categoryObj = questionsData[categoryId];
        for (const questionId in categoryObj) {
            const qData = categoryObj[questionId];

            const acceptableAnswersMap = migrateQuestionToMap(qData);

            const questionText = (qData.question || '').toLowerCase();
            const searchParts = [];
            Object.entries(acceptableAnswersMap).forEach(([key, list]) => {
                searchParts.push(key);
                list.forEach(item => searchParts.push(item));
            });
            const answersText = searchParts.join(' ').toLowerCase();

            if (searchQuery) {
                const matchesText = questionText.includes(searchQuery);
                const matchesAnswers = answersText.includes(searchQuery);
                const matchesId = questionId.toLowerCase().includes(searchQuery);
                if (!matchesText && !matchesAnswers && !matchesId) {
                    continue;
                }
            }

            questionsArray.push({
                id: questionId,
                category: categoryId,
                question: qData.question,
                acceptable_answers: acceptableAnswersMap
            });
        }
    }

    questionsArray.sort((a, b) => b.id.localeCompare(a.id));

    if (listCountSpan) {
        listCountSpan.textContent = `${questionsArray.length} soru`;
    }

    if (!questionsListContainer) return;

    if (questionsArray.length === 0) {
        questionsListContainer.innerHTML = `
            <div class="text-center py-20 text-neutral-500 text-sm">
                <i data-lucide="clipboard-list" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
                Arama kriterlerine uygun soru bulunamadı.
            </div>
        `;
        lucide.createIcons();
        return;
    }

    questionsListContainer.innerHTML = '';
    questionsArray.forEach(q => {
        const card = document.createElement('div');
        card.className = "bg-black border border-neutral-800 rounded-2xl p-4 flex flex-col justify-between gap-3 transition hover:border-emerald-900/60 hover:shadow-[0_0_15px_rgba(16,185,129,0.02)]";

        const categoryNames = {};
        loadCategories().forEach(c => { categoryNames[c.value] = c.label; });
        const catName = categoryNames[q.category] || q.category;

        card.innerHTML = `
            <div class="space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="px-2 py-0.5 bg-emerald-950/20 text-emerald-400 border border-emerald-900/30 rounded-md text-[10px] font-bold uppercase tracking-wider">
                        ${catName}
                    </span>
                    <span class="text-[10px] font-mono text-neutral-500 font-medium">
                        ${q.id}
                    </span>
                </div>
                <p class="text-sm font-semibold text-neutral-100 leading-snug">${escapeHtml(q.question)}</p>

                <div class="answers-wrapper hidden pt-2 border-t border-neutral-900/40 mt-1.5 space-y-1.5">
                    <span class="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1 font-bold">Kabul Edilen Cevaplar (Alternatifler için tıklayın):</span>
                    <div class="flex flex-wrap gap-2">
                        ${Object.entries(q.acceptable_answers || {}).map(([key, list]) => `
                            <div class="relative inline-block">
                                <button type="button" class="answer-badge px-2.5 py-1 bg-neutral-950 hover:bg-neutral-900 border border-neutral-855 hover:border-neutral-700 rounded-lg text-xs text-neutral-200 font-semibold cursor-pointer transition flex items-center gap-1.5 select-none">
                                    <span>${escapeHtml(key)}</span>
                                    ${list && list.length > 1 ? `<i data-lucide="git-branch" class="w-3 h-3 text-emerald-500"></i>` : ''}
                                </button>
                                <div class="alt-popover hidden absolute left-0 top-full mt-1.5 z-20 w-52 bg-neutral-900 border border-neutral-800 rounded-xl p-2.5 shadow-2xl text-[11px] text-neutral-300 transform origin-top scale-95 opacity-0 transition-all duration-150 pointer-events-auto">
                                    <div class="absolute -top-1 left-4 w-2 h-2 bg-neutral-900 border-t border-l border-neutral-800 rotate-45"></div>
                                    <div class="font-bold text-[9px] uppercase tracking-wider text-neutral-500 mb-1 flex items-center gap-1">
                                        <i data-lucide="git-branch" class="w-3 h-3 text-emerald-400"></i>
                                        <span>Alternatif Cevaplar</span>
                                    </div>
                                    <div class="flex flex-wrap gap-1 mt-1.5">
                                        ${list && list.length > 1 ?
                list.slice(1).map(alt => `<span class="px-1.5 py-0.5 bg-black border border-neutral-850 rounded text-neutral-300 font-mono">${escapeHtml(alt)}</span>`).join('')
                : `<span class="text-neutral-500 italic">Alternatif tanımlanmamış</span>`
            }
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-neutral-900/60 pt-3 mt-1">
                <button type="button" class="toggle-answers-btn shrink-0 px-1 py-1.5 min-[340px]:px-1.5 sm:px-2.5 sm:py-1.5 bg-neutral-950 hover:bg-neutral-900 border border-neutral-850 hover:border-neutral-800 text-neutral-400 hover:text-neutral-200 rounded-lg text-[9px] min-[340px]:text-[10px] sm:text-xs font-semibold transition cursor-pointer flex items-center gap-0.5 min-[340px]:gap-1 sm:gap-1.5 whitespace-nowrap">
                    <i data-lucide="eye" class="w-3 h-3 sm:w-3.5 sm:h-3.5 eye-icon shrink-0"></i>
                    <span class="btn-text whitespace-nowrap">Cevapları Gör</span>
                </button>

                <div class="flex items-center gap-1 sm:gap-2 shrink-0">
                    <button type="button" class="change-cat-btn px-2 py-1.5 sm:px-2.5 sm:py-1.5 bg-neutral-950 hover:bg-emerald-950/20 border border-neutral-850 hover:border-emerald-900/30 text-neutral-400 hover:text-emerald-400 rounded-lg text-[10px] sm:text-xs font-semibold transition cursor-pointer flex items-center justify-center shrink-0" title="Kategori Değiştir">
                        <i data-lucide="folder-sync" class="w-3 h-3"></i>
                    </button>
                    <button type="button" class="edit-q-btn px-2 py-1.5 sm:px-3 sm:py-1.5 bg-white hover:bg-emerald-50 hover:text-emerald-950 text-black rounded-lg text-[10px] sm:text-xs font-bold transition cursor-pointer flex items-center gap-1 sm:gap-1.5 shrink-0">
                        <i data-lucide="pencil" class="w-3 h-3"></i>
                        <span class="hidden sm:inline">Düzenle</span>
                    </button>
                    <button type="button" class="delete-q-btn px-2 py-1.5 sm:px-3 sm:py-1.5 bg-neutral-950 hover:bg-red-950/20 hover:text-red-400 hover:border-red-900/40 border border-neutral-850 text-neutral-500 rounded-lg text-[10px] sm:text-xs font-semibold transition cursor-pointer flex items-center gap-1 sm:gap-1.5 shrink-0">
                        <i data-lucide="trash-2" class="w-3 h-3"></i>
                        <span class="hidden sm:inline">Sil</span>
                    </button>
                </div>
            </div>
        `;

        const toggleAnswersBtn = card.querySelector('.toggle-answers-btn');
        const answersWrapper = card.querySelector('.answers-wrapper');
        const eyeIcon = toggleAnswersBtn.querySelector('.eye-icon');
        const btnText = toggleAnswersBtn.querySelector('.btn-text');

        toggleAnswersBtn.onclick = () => {
            const isHidden = answersWrapper.classList.toggle('hidden');
            toggleAnswersBtn.innerHTML = isHidden
                ? '<i data-lucide="eye" class="w-3 h-3 sm:w-3.5 sm:h-3.5 eye-icon shrink-0"></i><span class="btn-text whitespace-nowrap">Cevapları Gör</span>'
                : '<i data-lucide="eye-off" class="w-3 h-3 sm:w-3.5 sm:h-3.5 eye-icon shrink-0"></i><span class="btn-text whitespace-nowrap">Cevapları Gizle</span>';
            lucide.createIcons();
        };

        const popovers = card.querySelectorAll('.alt-popover');
        const badgeBtns = card.querySelectorAll('.answer-badge');

        badgeBtns.forEach((btn, idx) => {
            const popover = popovers[idx];
            btn.onclick = (e) => {
                e.stopPropagation();

                document.querySelectorAll('.alt-popover').forEach(p => {
                    if (p !== popover) {
                        p.classList.add('hidden', 'scale-95', 'opacity-0');
                        p.classList.remove('scale-100', 'opacity-100');
                    }
                });

                const isHidden = popover.classList.contains('hidden');
                if (isHidden) {
                    popover.classList.remove('hidden');
                    setTimeout(() => {
                        popover.classList.remove('scale-95', 'opacity-0');
                        popover.classList.add('scale-100', 'opacity-100');
                    }, 10);
                } else {
                    popover.classList.remove('scale-100', 'opacity-100');
                    popover.classList.add('scale-95', 'opacity-0');
                    setTimeout(() => {
                        popover.classList.add('hidden');
                    }, 150);
                }
            };
        });

        card.querySelector('.edit-q-btn').onclick = () => {
            startEditQuestion(q);
        };
        card.querySelector('.delete-q-btn').onclick = () => {
            deleteQuestion(q.category, q.id);
        };
        card.querySelector('.change-cat-btn').onclick = () => {
            changeCategoryOfQuestion(q);
        };

        questionsListContainer.appendChild(card);
    });

    if (viewAllModal && !viewAllModal.classList.contains('hidden')) {
        renderViewAllQuestionList();
    }

    lucide.createIcons();
}

function startEditQuestion(q) {
    isEditMode = true;
    editQuestionId = q.id;
    editOriginalCategory = q.category;

    categorySelect.value = q.category;
    questionTextarea.value = q.question;

    answersContainer.innerHTML = '';

    const entries = Object.entries(q.acceptable_answers || {});
    if (entries.length > 0) {
        entries.forEach(([key, list]) => {
            const mainAns = key;
            const alternatives = (list || []).filter(item => item !== key).join(', ');
            addAnswerInput(mainAns, alternatives);
        });
    } else {
        addAnswerInput('', '');
    }

    if (formTitle) formTitle.innerHTML = `<i data-lucide="pencil-line" class="w-5 h-5"></i> Soruyu Düzenle`;
    if (submitBtnText) submitBtnText.textContent = "Soruyu Güncelle";
    if (cancelEditBtn) cancelEditBtn.classList.remove('hidden');

    questionForm.scrollIntoView({ behavior: 'smooth' });
    showToast(`Soru düzenleme moduna alındı (${q.id})`, 'info');
    lucide.createIcons();
}

function cancelEdit() {
    isEditMode = false;
    editQuestionId = null;
    editOriginalCategory = null;

    questionForm.reset();
    answersContainer.innerHTML = '';
    addAnswerInput();

    if (formTitle) formTitle.innerHTML = `<i data-lucide="plus-circle" class="w-5 h-5"></i> Yeni Soru Ekle`;
    if (submitBtnText) submitBtnText.textContent = "Soruyu Veritabanına Gönder";
    if (cancelEditBtn) cancelEditBtn.classList.add('hidden');

    lucide.createIcons();
}

if (cancelEditBtn) {
    cancelEditBtn.onclick = () => {
        cancelEdit();
    };
}

async function deleteQuestion(category, id) {
    if (!db) return;
    const confirmed = await appConfirm("Bu soruyu silmek istediğinize emin misiniz?");
    if (!confirmed) {
        return;
    }

    try {
        const dbRef = ref(db, `questions_pool/${category}/${id}`);
        await remove(dbRef);
        showToast("Soru başarıyla silindi.", "success");

        if (isEditMode && editQuestionId === id) {
            cancelEdit();
        }
    } catch (err) {
        console.error("Error deleting question:", err);
        showToast("Soru silinirken hata oluştu: " + err.message, "error");
    }
}

async function changeCategoryOfQuestion(q) {
    if (!db) return;

    const cats = loadCategories();
    const categoryNames = {};
    cats.forEach(c => { categoryNames[c.value] = c.label; });
    const currentCatLabel = categoryNames[q.category] || q.category;

    const optionsHtml = cats
        .filter(c => c.value !== q.category)
        .map(c => `<option value="${c.value}">${c.label}</option>`)
        .join('');

    if (!optionsHtml) {
        showToast("Taşınacak başka kategori yok. Önce yeni bir kategori ekleyin.", "error");
        return;
    }

    return new Promise((resolve) => {
        modalMessage.textContent = `"${currentCatLabel}" kategorisindeki bu soruyu hangi kategoriye taşımak istiyorsunuz?`;
        modalInput.classList.add('hidden');
        modalConfirmBtn.textContent = 'Taşı';

        const tempSelect = document.createElement('select');
        tempSelect.className = 'w-full px-4 py-2.5 bg-black border border-neutral-800 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-emerald-800/40 focus:border-emerald-700 transition text-sm mb-5 appearance-none cursor-pointer';
        tempSelect.innerHTML = `<option value="" disabled selected>Kategori seçin...</option>${optionsHtml}`;
        tempSelect.id = 'modal-cat-select';

        modalMessage.after(tempSelect);
        showModal();

        const cleanup = () => {
            modalConfirmBtn.onclick = null;
            modalCancelBtn.onclick = null;
            modalBackdrop.onclick = null;
            tempSelect.remove();
            hideModal();
        };

        modalConfirmBtn.onclick = async () => {
            const newCategory = tempSelect.value;
            if (!newCategory) {
                showToast("Lütfen bir kategori seçin.", "error");
                return;
            }
            cleanup();

            try {
                const newCatLabel = categoryNames[newCategory] || newCategory;

                const questionData = {
                    category: newCatLabel,
                    question: q.question,
                    acceptable_answers: q.acceptable_answers || {}
                };
                const newRef = ref(db, `questions_pool/${newCategory}/${q.id}`);
                await set(newRef, questionData);

                const oldRef = ref(db, `questions_pool/${q.category}/${q.id}`);
                await remove(oldRef);

                showToast(`Soru "${newCatLabel}" kategorisine taşındı.`, 'success');

                if (isEditMode && editQuestionId === q.id) {
                    cancelEdit();
                }
            } catch (err) {
                console.error("Error moving question:", err);
                showToast("Soru taşınırken hata oluştu: " + err.message, "error");
            }
            resolve();
        };

        modalCancelBtn.onclick = () => { cleanup(); resolve(); };
        modalBackdrop.onclick = () => { cleanup(); resolve(); };
    });
}

toggleConfigBtn.onclick = () => {
    configPanel.classList.toggle('hidden');
};
closeConfigBtn.onclick = () => {
    configPanel.classList.add('hidden');
};

resetConfigBtn.onclick = async (e) => {
    if (e) e.preventDefault();
    const confirmed = await appConfirm("Firebase yapılandırma verilerini sıfırlamak istediğinize emin misiniz?");
    if (confirmed) {
        localStorage.removeItem('firebase_cms_config');
        configForm.reset();
        updateConnectionBadge(false, "Firebase ayarları temizlendi.");
        db = null;
        firebaseApp = null;

        questionsData = {};
        renderQuestionList();
    }
};

migrateDbBtn.onclick = async (e) => {
    if (e) e.preventDefault();

    if (!isFirebaseConnected || !db) {
        showToast("Firebase veritabanı bağlı değil! Göç işlemi için önce bağlantı kurmalısınız.", "error");
        return;
    }

    const confirmed = await appConfirm("Eski soruları yeni şemaya senkronize etmek istediğinize emin misiniz?");
    if (!confirmed) return;

    migrateDbBtn.disabled = true;
    migrateDbBtn.classList.add('opacity-50', 'cursor-not-allowed');
    const origText = migrateDbBtn.innerHTML;
    migrateDbBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin mr-1"></i> Göç ettiriliyor...`;
    lucide.createIcons();

    try {
        const snapshot = await get(ref(db, 'questions_pool'));
        if (!snapshot.exists()) {
            showToast("Veritabanında soru havuzu bulunamadı.", "info");
            return;
        }

        const pool = snapshot.val();
        let migratedCount = 0;

        for (const categoryId in pool) {
            const categoryObj = pool[categoryId];
            for (const questionId in categoryObj) {
                const qData = categoryObj[questionId];

                const hasCorrectAnswer = 'correctAnswer' in qData;
                const hasAnswers = 'answers' in qData;
                const isAcceptableArray = qData.acceptable_answers && Array.isArray(qData.acceptable_answers);
                const isAcceptedArray = qData.accepted_answers && Array.isArray(qData.accepted_answers);

                if (hasCorrectAnswer || hasAnswers || isAcceptableArray || isAcceptedArray) {
                    const acceptableAnswersMap = migrateQuestionToMap(qData);

                    const migratedData = {
                        category: qData.category || categoryId,
                        question: qData.question || '',
                        acceptable_answers: acceptableAnswersMap
                    };

                    await set(ref(db, `questions_pool/${categoryId}/${questionId}`), migratedData);
                    migratedCount++;
                }
            }
        }

        showToast(`${migratedCount} eski soru yeni Map şemasına başarıyla göç ettirildi!`, "success");
    } catch (err) {
        console.error("Migration failed:", err);
        showToast("Veritabanı göç ettirilirken hata oluştu: " + err.message, "error");
    } finally {
        migrateDbBtn.disabled = false;
        migrateDbBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        migrateDbBtn.innerHTML = origText;
        lucide.createIcons();
    }
};

configForm.onsubmit = async (e) => {
    e.preventDefault();
    const config = {
        apiKey: document.getElementById('cfg-apiKey').value.trim(),
        authDomain: document.getElementById('cfg-authDomain').value.trim(),
        databaseURL: document.getElementById('cfg-databaseURL').value.trim(),
        projectId: document.getElementById('cfg-projectId').value.trim(),
        storageBucket: document.getElementById('cfg-storageBucket').value.trim(),
        appId: document.getElementById('cfg-appId').value.trim()
    };

    if (!config.apiKey || !config.databaseURL) {
        showToast("Lütfen en az API Key ve Database URL alanlarını doldurun.", "error");
        return;
    }

    localStorage.setItem('firebase_cms_config', JSON.stringify(config));
    const success = await setupFirebase(config);
    if (success) {
        configPanel.classList.add('hidden');
    }
};

let answerCounter = 0;

function getPlaceholderForCategory() {
    const cat = categorySelect.value;
    if (!cat || !PLACEHOLDERS[cat]) return "Bir cevap alternatifi yazın...";
    const list = PLACEHOLDERS[cat];
    return list[Math.floor(Math.random() * list.length)];
}

function addAnswerInput(value = '', altValue = '', scrollToView = false) {
    answerCounter++;
    const answerId = `ans_${Date.now()}_${answerCounter}`;

    const itemContainer = document.createElement('div');
    itemContainer.id = answerId;
    itemContainer.className = "flex flex-col gap-2 bg-neutral-950/40 border border-neutral-900 rounded-2xl p-3 transition-all duration-300 ease-out transform scale-95 opacity-0 translate-y-2";

    const mainRow = document.createElement('div');
    mainRow.className = "flex items-center gap-2.5";

    const numSpan = document.createElement('span');
    numSpan.className = "text-xs font-bold text-neutral-500 w-5 text-center answer-num-index";

    const input = document.createElement('input');
    input.type = "text";
    input.required = true;
    input.value = value;
    input.placeholder = getPlaceholderForCategory();
    input.setAttribute('data-answer', 'true');
    input.className = "flex-1 px-4 py-2.5 bg-black border border-neutral-800 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-emerald-800/40 focus:border-emerald-700 transition placeholder-neutral-600 text-sm";

    const altBtn = document.createElement('button');
    altBtn.type = "button";
    altBtn.className = "p-2.5 bg-black hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-emerald-400 rounded-xl transition cursor-pointer flex items-center justify-center shrink-0 w-10 h-10";
    altBtn.title = "Alternatif Cevaplar Ekle/Düzenle";
    altBtn.innerHTML = `<i data-lucide="git-branch" class="w-4.5 h-4.5"></i>`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = "button";
    deleteBtn.className = "p-2.5 bg-black hover:bg-red-950/20 border border-neutral-800 hover:border-red-900/40 text-neutral-500 hover:text-red-400 rounded-xl transition cursor-pointer flex items-center justify-center shrink-0";
    deleteBtn.innerHTML = `<i data-lucide="x" class="w-4.5 h-4.5"></i>`;
    deleteBtn.onclick = () => {
        removeAnswerInput(answerId);
    };

    const altRow = document.createElement('div');
    altRow.className = "pl-7 transition-all duration-200 hidden";

    const altInput = document.createElement('input');
    altInput.type = "text";
    altInput.value = altValue;
    altInput.placeholder = "Alternatifleri virgülle ayırarak yazın (Örn: Polat, polatalemdar)";
    altInput.setAttribute('data-alternatives', 'true');
    altInput.className = "w-full px-4 py-2 bg-neutral-950 border border-neutral-850 rounded-xl text-xs text-neutral-300 focus:outline-none focus:ring-2 focus:ring-emerald-800/40 focus:border-emerald-800/60 transition placeholder-neutral-700";

    if (altValue) {
        altRow.classList.remove('hidden');
        altBtn.classList.remove('text-neutral-400', 'border-neutral-800');
        altBtn.classList.add('text-emerald-400', 'border-emerald-900/30', 'bg-emerald-950/20');
    }

    altBtn.onclick = () => {
        const isHidden = altRow.classList.toggle('hidden');
        if (!isHidden) {
            altInput.focus();
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            checkDuplicateAnswers();
            addAnswerInput('', '', true);
        } else if (e.key === 'Control' || (e.key === 'Enter' && e.ctrlKey)) {
            e.preventDefault();
            altRow.classList.remove('hidden');
            altBtn.classList.remove('text-neutral-400', 'border-neutral-800');
            altBtn.classList.add('text-emerald-400', 'border-emerald-900/30', 'bg-emerald-950/20');
            altInput.focus();
        }
    });

    altInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            checkDuplicateAnswers();
            addAnswerInput('', '', true);
        }
    });

    altInput.addEventListener('input', () => {
        const hasContent = altInput.value.trim() !== '';
        if (hasContent) {
            altBtn.classList.remove('text-neutral-400', 'border-neutral-800');
            altBtn.classList.add('text-emerald-400', 'border-emerald-900/30', 'bg-emerald-950/20');
        } else {
            altBtn.classList.add('text-neutral-400', 'border-neutral-800');
            altBtn.classList.remove('text-emerald-400', 'border-emerald-900/30', 'bg-emerald-950/20');
        }
        checkDuplicateAnswers();
    });

    mainRow.appendChild(numSpan);
    mainRow.appendChild(input);
    mainRow.appendChild(altBtn);
    mainRow.appendChild(deleteBtn);

    altRow.appendChild(altInput);

    itemContainer.appendChild(mainRow);
    itemContainer.appendChild(altRow);

    answersContainer.appendChild(itemContainer);

    setTimeout(() => {
        itemContainer.classList.remove('scale-95', 'opacity-0', 'translate-y-2');
        itemContainer.classList.add('scale-100', 'opacity-100', 'translate-y-0');
        reindexAnswers();
        lucide.createIcons();

        if (scrollToView) {
            input.focus({ preventScroll: true });

            setTimeout(() => {
                answersContainer.scrollTop = answersContainer.scrollHeight + 100;
            }, 50);
        }
    }, 15);
}

function removeAnswerInput(id) {
    const div = document.getElementById(id);
    if (!div) return;

    div.classList.remove('scale-100', 'opacity-100', 'translate-y-0');
    div.classList.add('scale-95', 'opacity-0', 'translate-y-2');

    setTimeout(() => {
        div.remove();
        reindexAnswers();
    }, 250);
}

function reindexAnswers() {
    const indexSpans = document.querySelectorAll('.answer-num-index');
    indexSpans.forEach((span, idx) => {
        span.textContent = idx + 1;
    });
}

function checkDuplicateAnswers() {
    const itemContainers = answersContainer.querySelectorAll('.flex-col');
    let hasGlobalDuplicate = false;

    itemContainers.forEach(container => {
        const mainInp = container.querySelector('input[data-answer]');
        const altInp = container.querySelector('input[data-alternatives]');
        if (mainInp) clearInputError(mainInp);
        if (altInp) clearInputError(altInp);
    });

    const seenAnswers = new Map(); // tracks where we saw each value

    itemContainers.forEach((container) => {
        const mainInp = container.querySelector('input[data-answer]');
        const altInp = container.querySelector('input[data-alternatives]');

        if (!mainInp) return;

        const mainVal = toTurkishLowerCase(mainInp.value.trim());
        if (mainVal) {
            if (seenAnswers.has(mainVal)) {
                markInputError(mainInp);
                markInputError(seenAnswers.get(mainVal));
                hasGlobalDuplicate = true;
            } else {
                seenAnswers.set(mainVal, mainInp);
            }
        }

        if (altInp) {
            const altVal = altInp.value.trim();
            if (altVal) {
                const parts = altVal.split(',');
                const localSeen = new Set();
                parts.forEach(part => {
                    const val = toTurkishLowerCase(part.trim());
                    if (!val) return;

                    if (val === mainVal) {
                        return;
                    }

                    if (localSeen.has(val)) {
                        markInputError(altInp);
                        hasGlobalDuplicate = true;
                    } else {
                        localSeen.add(val);
                    }

                    if (seenAnswers.has(val)) {
                        markInputError(altInp);
                        markInputError(seenAnswers.get(val));
                        hasGlobalDuplicate = true;
                    } else {
                        seenAnswers.set(val, altInp);
                    }
                });
            }
        }
    });

    return hasGlobalDuplicate;
}

function markInputError(inputEl) {
    inputEl.style.borderColor = 'rgba(239, 68, 68, 0.6)';
    inputEl.style.boxShadow = '0 0 0 2px rgba(239, 68, 68, 0.15)';
    inputEl.style.animation = 'shake 0.3s ease';
}

function clearInputError(inputEl) {
    inputEl.style.borderColor = '';
    inputEl.style.boxShadow = '';
    inputEl.style.animation = '';
}

answersContainer.addEventListener('input', (e) => {
    if (e.target && (e.target.matches('input[data-answer]') || e.target.matches('input[data-alternatives]'))) {
        checkDuplicateAnswers();
    }
});

addAnswerBtn.onclick = () => {
    addAnswerInput('', '', true);
};

categorySelect.onchange = () => {
    const inputs = answersContainer.querySelectorAll('input[data-answer]');
    inputs.forEach(input => {
        if (!input.value) {
            input.placeholder = getPlaceholderForCategory();
        }
    });
};

questionForm.onsubmit = async (e) => {
    e.preventDefault();

    if (!isFirebaseConnected || !db) {
        showToast("Firebase veritabanı bağlı değil! Lütfen ayarlardan yapılandırmanızı girin.", "error");
        configPanel.classList.remove('hidden');
        configPanel.scrollIntoView({ behavior: 'smooth' });
        return;
    }

    if (checkDuplicateAnswers()) {
        showToast("Lütfen mükerrer (aynı) cevapları veya alternatifleri düzeltin.", "error");
        return;
    }

    const kategori = categorySelect.value;
    const soruMetni = questionTextarea.value.trim();

    const itemContainers = answersContainer.querySelectorAll('.flex-col');
    const acceptableAnswersMap = {};
    let hasAnswers = false;

    itemContainers.forEach(container => {
        const mainInp = container.querySelector('input[data-answer]');
        const altInp = container.querySelector('input[data-alternatives]');
        if (!mainInp) return;

        const mainVal = mainInp.value.trim();
        if (!mainVal) return;

        const key = toTurkishLowerCase(mainVal);
        const list = [key];

        if (altInp) {
            const altVal = altInp.value.trim();
            if (altVal) {
                altVal.split(',').forEach(part => {
                    const normPart = toTurkishLowerCase(part.trim());
                    if (normPart && !list.includes(normPart)) {
                        list.push(normPart);
                    }
                });
            }
        }

        acceptableAnswersMap[key] = list;
        hasAnswers = true;
    });

    if (!kategori) {
        showToast("Lütfen bir kategori seçin.", "error");
        return;
    }
    if (!soruMetni) {
        showToast("Lütfen soru metnini yazın.", "error");
        return;
    }
    if (!hasAnswers) {
        showToast("Lütfen en az bir kabul edilen cevap girin.", "error");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-75', 'cursor-not-allowed');
    submitSpinner.classList.remove('hidden');
    submitBtnText.textContent = isEditMode ? "Soruyu Güncelliyor..." : "Soruyu Firebase'e Gönderiyor...";

    try {
        const selectedCatObj = loadCategories().find(c => c.value === kategori);
        const categoryLabel = selectedCatObj ? selectedCatObj.label : kategori;

        const questionData = {
            category: categoryLabel,
            question: soruMetni,
            acceptable_answers: acceptableAnswersMap
        };

        if (isEditMode) {

            const oldPath = `questions_pool/${editOriginalCategory}/${editQuestionId}`;
            const newPath = `questions_pool/${kategori}/${editQuestionId}`;

            if (editOriginalCategory !== kategori) {

                await set(ref(db, newPath), questionData);
                await remove(ref(db, oldPath));
            } else {

                await set(ref(db, oldPath), questionData);
            }

            showToast("Soru başarıyla güncellendi!", "success");
            cancelEdit();
        } else {

            const timestamp = Date.now();
            const soruId = `q_${timestamp}`;
            const dbRef = ref(db, `questions_pool/${kategori}/${soruId}`);

            await set(dbRef, questionData);
            showToast("Soru başarıyla kaydedildi!", "success");

            questionForm.reset();
            answersContainer.innerHTML = '';
            addAnswerInput();
        }
    } catch (err) {
        console.error("Database save failure:", err);
        showToast(`Soru kaydedilirken hata oluştu: ${err.message}`, "error");
    } finally {

        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        submitSpinner.classList.add('hidden');
        submitBtnText.textContent = isEditMode ? "Soruyu Güncelle" : "Soruyu Veritabanına Gönder";
    }
};

if (searchInput) {
    searchInput.oninput = () => {
        renderQuestionList();
    };
}

if (filterCategory) {
    filterCategory.onchange = () => {
        renderQuestionList();
    };
}

if (viewAllQuestionsBtn) {
    viewAllQuestionsBtn.onclick = () => {
        openViewAllModal();
    };
}

if (viewAllCloseBtn) {
    viewAllCloseBtn.onclick = () => {
        closeViewAllModal();
    };
}

if (viewAllBackdrop) {
    viewAllBackdrop.onclick = () => {
        closeViewAllModal();
    };
}

if (viewAllSearchQuestionInput) {
    viewAllSearchQuestionInput.oninput = () => {
        renderViewAllQuestionList();
    };
}

if (viewAllSearchAnswerInput) {
    viewAllSearchAnswerInput.oninput = () => {
        renderViewAllQuestionList();
    };
}

if (viewAllFilterCategory) {
    viewAllFilterCategory.onchange = () => {
        renderViewAllQuestionList();
    };
}

if (exportBackupBtn) {
    exportBackupBtn.onclick = () => exportBackupData();
}

if (importBackupInput) {
    importBackupInput.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
            importBackupData(file);

            importBackupInput.value = '';
        }
    };
}

window.addEventListener('DOMContentLoaded', async () => {
    const activeConfig = loadConfigFromStorage();
    if (activeConfig) {
        await setupFirebase(activeConfig);
    } else {
        updateConnectionBadge(false);
        configPanel.classList.remove('hidden');
    }

    addAnswerInput();

    document.addEventListener('click', () => {
        document.querySelectorAll('.alt-popover').forEach(p => {
            p.classList.add('hidden', 'scale-95', 'opacity-0');
            p.classList.remove('scale-100', 'opacity-100');
        });
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !viewAllModal.classList.contains('hidden')) {
            closeViewAllModal();
        }
    });

    lucide.createIcons();
});

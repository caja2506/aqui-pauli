import { collection, doc, setDoc, updateDoc, deleteDoc, getDocs, writeBatch, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { slugify } from '../utils/formatters';

const PRODUCTS_COL = 'products';

/**
 * Crea un producto nuevo
 */
export async function createProduct(data) {
  const ref = doc(collection(db, PRODUCTS_COL));
  const product = {
    name: data.name,
    slug: slugify(data.name),
    description: data.description || '',
    brandRef: data.brandId ? doc(db, 'brands', data.brandId) : null,
    categoryRefs: (data.categoryIds || []).map(id => doc(db, 'categories', id)),
    images: data.images || [],
    basePrice: Number(data.basePrice) || 0,
    active: true,
    deleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await setDoc(ref, product);
  return ref.id;
}

/**
 * Actualiza un producto existente
 */
export async function updateProduct(productId, data) {
  const ref = doc(db, PRODUCTS_COL, productId);
  const updates = {
    ...data,
    updatedAt: new Date().toISOString(),
  };
  if (data.name) updates.slug = slugify(data.name);
  if (data.brandId !== undefined) {
    updates.brandRef = data.brandId ? doc(db, 'brands', data.brandId) : null;
    delete updates.brandId;
  }
  if (data.categoryIds !== undefined) {
    updates.categoryRefs = data.categoryIds.map(id => doc(db, 'categories', id));
    delete updates.categoryIds;
  }
  await updateDoc(ref, updates);
}

/**
 * Borrado lógico de un producto
 */
export async function deleteProduct(productId) {
  await updateDoc(doc(db, PRODUCTS_COL, productId), {
    deleted: true,
    active: false,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Activa/desactiva un producto
 */
export async function toggleProductActive(productId, active) {
  await updateDoc(doc(db, PRODUCTS_COL, productId), {
    active,
    updatedAt: new Date().toISOString(),
  });
}

// --- Variantes ---

/**
 * Crea una variante para un producto
 */
export async function createVariant(productId, data) {
  const ref = doc(collection(db, PRODUCTS_COL, productId, 'variants'));
  const variant = {
    name: data.name || '',
    sku: data.sku || '',
    price: Number(data.price) || 0,
    stock: Number(data.stock) || 0,
    reservedStock: 0,
    imageUrl: data.imageUrl || '',
    commercialStatus: data.commercialStatus || 'disponible',
    supplyType: data.supplyType || 'stock_propio',
    attributes: data.attributes || {},
    active: true,
    order: data.order || 0,
  };
  await setDoc(ref, variant);
  return ref.id;
}

/**
 * Actualiza una variante
 */
export async function updateVariant(productId, variantId, data) {
  const ref = doc(db, PRODUCTS_COL, productId, 'variants', variantId);
  await updateDoc(ref, data);
}

/**
 * Elimina una variante
 */
export async function deleteVariant(productId, variantId) {
  await deleteDoc(doc(db, PRODUCTS_COL, productId, 'variants', variantId));
}

// --- Marcas y Categorías ---

export async function createBrand(name) {
  const ref = doc(collection(db, 'brands'));
  await setDoc(ref, {
    name,
    slug: slugify(name),
    logoUrl: '',
    active: true,
    createdAt: new Date().toISOString(),
  });
  return ref.id;
}

export async function updateBrand(id, data) {
  await updateDoc(doc(db, 'brands', id), {
    ...data,
    slug: data.name ? slugify(data.name) : undefined,
  });
}

export async function deleteBrand(id) {
  await deleteDoc(doc(db, 'brands', id));
}

export async function createCategory(data) {
  const ref = doc(collection(db, 'categories'));
  await setDoc(ref, {
    name: data.name,
    slug: slugify(data.name),
    description: data.description || '',
    imageUrl: data.imageUrl || '',
    parentId: data.parentId || null,
    active: true,
    order: data.order || 0,
    createdAt: new Date().toISOString(),
  });
  return ref.id;
}

export async function updateCategory(id, data) {
  await updateDoc(doc(db, 'categories', id), {
    ...data,
    slug: data.name ? slugify(data.name) : undefined,
  });
}

export async function deleteCategory(id) {
  await deleteDoc(doc(db, 'categories', id));
}

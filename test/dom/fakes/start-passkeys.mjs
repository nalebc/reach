export const faceIdReady = async () => !!globalThis.__reachStartTest.face;
export const signWithFaceId = () => globalThis.__reachStartTest.faceAnswer;
export const faceIdError = error => error.message;

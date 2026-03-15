import React, { useState } from 'react';
import { X, Camera, User, Upload } from 'lucide-react';
import { uploadAvatar } from '../services/cosService';

const EditProfileModal = ({ isOpen, onClose, userProfile, onSave }) => {
  const [formData, setFormData] = useState({
    username: userProfile?.username || '厦大学生',
    avatar: userProfile?.avatar || '',
    bio: userProfile?.bio || ''
  });
  const [isUploading, setIsUploading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // 如果有新头像，上传到COS
    if (formData.avatar && formData.avatar.startsWith('data:')) {
      setIsUploading(true);
      try {
        // 将base64转换为File对象
        const base64Data = formData.avatar.split(',')[1];
        const contentType = formData.avatar.split(';')[0].split(':')[1];
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: contentType });
        const file = new File([blob], 'avatar.jpg', { type: contentType });
        
        const uploadResult = await uploadAvatar(file);
        if (uploadResult.success) {
          formData.avatar = uploadResult.cosUrl;
        } else {
          console.error('头像上传失败:', uploadResult.error);
          alert('头像上传失败: ' + uploadResult.error);
          setIsUploading(false);
          return;
        }
      } catch (error) {
        console.error('头像上传错误:', error);
        alert('头像上传失败，请重试');
        setIsUploading(false);
        return;
      } finally {
        setIsUploading(false);
      }
    }
    
    onSave(formData);
    onClose();
  };

  const generateRandomAvatar = () => {
    const avatarKeywords = ['student', 'portrait', 'avatar', 'face', 'person'];
    const randomKeyword = avatarKeywords[Math.floor(Math.random() * avatarKeywords.length)];
    const avatarUrl = `https://nocode.meituan.com/photo/search?keyword=${randomKeyword}&width=200&height=200`;
    setFormData(prev => ({ ...prev, avatar: avatarUrl }));
  };

  // 处理头像上传
  const handleAvatarUpload = async (e) => {
    const file = e.target.files[0];
    if (file) {
      setIsUploading(true);
      try {
        const uploadResult = await uploadAvatar(file);
        if (uploadResult.success) {
          setFormData(prev => ({ ...prev, avatar: uploadResult.cosUrl }));
        } else {
          alert('头像上传失败: ' + uploadResult.error);
        }
      } catch (error) {
        console.error('头像上传错误:', error);
        alert('头像上传失败，请重试');
      } finally {
        setIsUploading(false);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-gray-800">编辑个人信息</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* 头像上传 */}
          <div className="text-center">
            <div className="relative inline-block">
              <div className="w-24 h-24 rounded-full overflow-hidden bg-gray-100 mx-auto mb-4">
                {formData.avatar ? (
                  <img
                    src={formData.avatar}
                    alt="头像"
                    className="w-full h-full mx-auto object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <User className="w-12 h-12 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="absolute bottom-0 right-0 flex gap-1">
                <label className="w-8 h-8 bg-purple-500 text-white rounded-full flex items-center justify-center hover:bg-purple-600 transition-colors duration-200 cursor-pointer">
                  <Upload className="w-4 h-4" />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                    className="hidden"
                    disabled={isUploading}
                  />
                </label>
                <button
                  type="button"
                  onClick={generateRandomAvatar}
                  className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center hover:bg-blue-600 transition-colors duration-200"
                  disabled={isUploading}
                >
                  <Camera className="w-4 h-4" />
                </button>
              </div>
            </div>
            <p className="text-sm text-gray-600">
              {isUploading ? '上传中...' : '点击上传图标选择图片，或点击相机图标随机生成'}
            </p>
          </div>

          {/* 用户名 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              用户名
            </label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
              placeholder="请输入用户名"
              className="w-full p-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              maxLength={20}
            />
          </div>

          {/* 个人简介 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              个人简介
            </label>
            <textarea
              value={formData.bio}
              onChange={(e) => setFormData(prev => ({ ...prev, bio: e.target.value }))}
              placeholder="介绍一下自己吧..."
              className="w-full p-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
              rows="3"
              maxLength={100}
            />
            <p className="text-xs text-gray-500 mt-1">
              {formData.bio.length}/100
            </p>
          </div>

          {/* 提交按钮 */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 border border-gray-200 text-gray-600 rounded-lg font-medium hover:bg-gray-50 transition-all duration-200"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 bg-gradient-to-r from-blue-500 to-purple-500 text-white py-3 rounded-lg font-medium hover:shadow-lg transition-all duration-200"
              disabled={isUploading}
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EditProfileModal;
